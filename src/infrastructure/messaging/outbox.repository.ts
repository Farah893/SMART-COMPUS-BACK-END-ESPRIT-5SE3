import type { EventEnvelope } from "./event-envelope.js";
import { Outbox, type OutboxEntity } from "./outbox.model.js";

export interface OutboxRepository {
  add(envelope: EventEnvelope): Promise<void>;
  /** Réserve (bail) jusqu'à `limit` événements prêts, dans l'ordre. Chaque réservation est atomique. */
  claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxEntity[]>;
  markPublished(eventId: string, now: Date, retentionMs: number): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  countPending(): Promise<number>;
}

export class MongoOutboxRepository implements OutboxRepository {
  add: OutboxRepository["add"] = async (e) => {
    await Outbox.create({ eventId: e.id, name: e.name, version: e.version, occurredAt: new Date(e.occurredAt), payload: e.payload });
  };

  claimBatch: OutboxRepository["claimBatch"] = async (limit, leaseMs, now) => {
    const claimed: OutboxEntity[] = [];
    for (let i = 0; i < limit; i++) {
      // Un document n'est réservé que s'il est en attente, échu, et sans bail en cours : deux instances ne se le disputent pas.
      const doc = await Outbox.findOneAndUpdate(
        {
          status: "pending",
          nextAttemptAt: { $lte: now },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
        },
        { lockedUntil: new Date(now.getTime() + leaseMs), $inc: { attempts: 1 } },
        { sort: { occurredAt: 1 }, new: true },
      )
        .lean<OutboxEntity>()
        .exec();
      if (!doc) break;
      claimed.push(doc);
    }
    return claimed;
  };

  markPublished: OutboxRepository["markPublished"] = async (eventId, now, retentionMs) => {
    await Outbox.updateOne(
      { eventId },
      { status: "published", publishedAt: now, lockedUntil: null, lastError: null, expiresAt: new Date(now.getTime() + retentionMs) },
    );
  };

  markFailed: OutboxRepository["markFailed"] = async (eventId, error, nextAttemptAt) => {
    await Outbox.updateOne({ eventId }, { lockedUntil: null, lastError: error.slice(0, 500), nextAttemptAt });
  };

  countPending = () => Outbox.countDocuments({ status: "pending" }).exec();
}
