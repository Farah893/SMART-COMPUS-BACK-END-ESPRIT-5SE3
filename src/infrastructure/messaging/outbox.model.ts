import mongoose, { Schema } from "mongoose";
import type { DomainEventName } from "../../shared/constants/index.js";

export interface OutboxEntity {
  eventId: string;
  name: DomainEventName;
  version: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
  status: "pending" | "published";
  attempts: number;
  /** Pas de nouvelle tentative avant cette date (backoff exponentiel). */
  nextAttemptAt: Date;
  /** Bail : un relais qui plante laisse l'événement « réservé » jusqu'à cette date, puis un autre le reprend. */
  lockedUntil?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
  /** Posé à la publication : MongoDB supprime l'événement après la durée de rétention (index TTL). */
  expiresAt?: Date | null;
}

const outboxSchema = new Schema<OutboxEntity>({
  eventId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  version: { type: Number, required: true },
  occurredAt: { type: Date, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["pending", "published"], default: "pending", index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  expiresAt: { type: Date, default: null, expires: 0 },
});
outboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const Outbox = mongoose.model<OutboxEntity>("Outbox", outboxSchema);
