import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnvelope, EVENT_SCHEMA_VERSION, routingKeyOf, type EventEnvelope } from "../src/infrastructure/messaging/event-envelope.js";
import { OutboxEventPublisher } from "../src/infrastructure/messaging/outbox-publisher.js";
import { OutboxRelay, type EventTransport } from "../src/infrastructure/messaging/outbox-relay.js";
import type { OutboxEntity } from "../src/infrastructure/messaging/outbox.model.js";
import type { OutboxRepository } from "../src/infrastructure/messaging/outbox.repository.js";

/** Boîte d'envoi en mémoire, avec les mêmes règles de réservation (bail) et de reprise que la version MongoDB. */
class InMemoryOutbox implements OutboxRepository {
  rows: OutboxEntity[] = [];
  add = async (e: EventEnvelope) => {
    this.rows.push({
      eventId: e.id, name: e.name, version: e.version, occurredAt: new Date(e.occurredAt), payload: e.payload,
      status: "pending", attempts: 0, nextAttemptAt: new Date(0), lockedUntil: null,
    });
  };
  claimBatch = async (limit: number, leaseMs: number, now: Date) => {
    const ready = this.rows
      .filter((r) => r.status === "pending" && r.nextAttemptAt <= now && (!r.lockedUntil || r.lockedUntil < now))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, limit);
    for (const r of ready) {
      r.lockedUntil = new Date(now.getTime() + leaseMs);
      r.attempts += 1;
    }
    return ready.map((r) => ({ ...r }));
  };
  markPublished = async (id: string, now: Date, retentionMs: number) => {
    const r = this.rows.find((x) => x.eventId === id)!;
    Object.assign(r, { status: "published", publishedAt: now, lockedUntil: null, expiresAt: new Date(now.getTime() + retentionMs) });
  };
  markFailed = async (id: string, error: string, next: Date) => {
    Object.assign(this.rows.find((x) => x.eventId === id)!, { lockedUntil: null, lastError: error, nextAttemptAt: next });
  };
  countPending = async () => this.rows.filter((r) => r.status === "pending").length;
}

class FakeTransport implements EventTransport {
  connected = false;
  reachable = true;
  failPublish = false;
  connectCalls = 0;
  sent: EventEnvelope[] = [];
  isConnected = () => this.connected;
  connect = async () => {
    this.connectCalls++;
    if (!this.reachable) throw new Error("ECONNREFUSED");
    this.connected = true;
  };
  publish = async (e: EventEnvelope) => {
    if (this.failPublish) throw new Error("nack");
    this.sent.push(e);
  };
  close = async () => { this.connected = false; };
}

function setup() {
  let clock = new Date("2026-01-01T00:00:00Z");
  const outbox = new InMemoryOutbox();
  const transport = new FakeTransport();
  const relay = new OutboxRelay(outbox, transport, {
    pollMs: 1000, batchSize: 10, leaseMs: 30_000, retentionMs: 7 * 86_400_000, maxBackoffMs: 60_000, now: () => clock,
  });
  return {
    outbox, transport, relay,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    publisher: new OutboxEventPublisher(outbox, { enabled: true }),
  };
}

test("enveloppe : champs historiques conservés, id et version ajoutés, clé de routage inchangée", () => {
  const e = createEnvelope("RôleModifié", { id: "ETU-2026-0001" }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(e.name, "RôleModifié");
  assert.equal(e.occurredAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(e.payload, { id: "ETU-2026-0001" });
  assert.equal(e.version, EVENT_SCHEMA_VERSION);
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.equal(routingKeyOf(e.name), "user.RôleModifié");
});

test("sans RabbitMQ configuré, la boîte d'envoi ne s'accumule pas", async () => {
  const outbox = new InMemoryOutbox();
  await new OutboxEventPublisher(outbox, { enabled: false }).publish("UtilisateurCréé", { id: "x" });
  assert.equal(outbox.rows.length, 0);
});

test("une panne de la boîte d'envoi ne fait pas échouer l'opération métier", async () => {
  const broken = { ...new InMemoryOutbox(), add: async () => { throw new Error("mongo down"); } } as unknown as OutboxRepository;
  await assert.doesNotReject(new OutboxEventPublisher(broken, { enabled: true }).publish("UtilisateurCréé", { id: "x" }));
});

test("le relais publie dans l'ordre, puis marque les événements publiés (rétention TTL posée)", async () => {
  const { outbox, transport, relay, publisher, advance } = setup();
  transport.connected = true;
  await publisher.publish("UtilisateurCréé", { n: 1 });
  advance(10);
  await publisher.publish("RôleModifié", { n: 2 });

  // `occurredAt` provient de l'horloge réelle des enveloppes ; on force un ordre déterministe.
  outbox.rows[0]!.occurredAt = new Date(1);
  outbox.rows[1]!.occurredAt = new Date(2);

  assert.deepEqual(await relay.runOnce(), { published: 2, failed: 0 });
  assert.deepEqual(transport.sent.map((e) => e.payload.n), [1, 2]);
  assert.ok(outbox.rows.every((r) => r.status === "published" && r.expiresAt));
  assert.deepEqual(await relay.runOnce(), { published: 0, failed: 0 }, "rien n'est republié");
});

test("bus indisponible : les événements restent intacts, la reconnexion se fait avec backoff, puis tout part", async () => {
  const { outbox, transport, relay, publisher, advance } = setup();
  transport.reachable = false;
  await publisher.publish("UtilisateurCréé", { n: 1 });

  await relay.runOnce();
  assert.equal(transport.connectCalls, 1);
  assert.equal(outbox.rows[0]!.attempts, 0, "rien n'est réservé tant que le bus est absent");

  await relay.runOnce(); // trop tôt : le backoff empêche de marteler le bus
  assert.equal(transport.connectCalls, 1);

  advance(1500);
  await relay.runOnce();
  assert.equal(transport.connectCalls, 2);
  assert.equal(transport.sent.length, 0);

  transport.reachable = true; // RabbitMQ redémarre
  advance(10_000);
  assert.deepEqual(await relay.runOnce(), { published: 1, failed: 0 });
  assert.equal(transport.sent.length, 1);
});

test("nack du courtier : nouvelle tentative planifiée avec backoff exponentiel, sans perte", async () => {
  const { outbox, transport, relay, publisher, advance } = setup();
  transport.connected = true;
  transport.failPublish = true;
  await publisher.publish("UtilisateurCréé", { n: 1 });

  assert.deepEqual(await relay.runOnce(), { published: 0, failed: 1 });
  const row = outbox.rows[0]!;
  assert.equal(row.status, "pending");
  assert.equal(row.lastError, "nack");

  assert.deepEqual(await relay.runOnce(), { published: 0, failed: 0 }, "pas de nouvelle tentative avant l'échéance");

  transport.failPublish = false;
  advance(5_000);
  assert.deepEqual(await relay.runOnce(), { published: 1, failed: 0 });
  assert.equal(transport.sent[0]!.id, row.eventId, "même identifiant : les consommateurs peuvent dédupliquer");
});

test("bail : un événement réservé par un relais planté est repris après l'expiration du bail, pas avant", async () => {
  const { outbox, transport, relay, publisher, advance } = setup();
  transport.connected = true;
  await publisher.publish("UtilisateurCréé", { n: 1 });

  // Un premier relais réserve l'événement puis « plante » avant de publier.
  await outbox.claimBatch(10, 30_000, new Date("2026-01-01T00:00:00Z"));

  advance(10_000);
  assert.deepEqual(await relay.runOnce(), { published: 0, failed: 0 }, "bail encore actif");
  advance(25_000);
  assert.deepEqual(await relay.runOnce(), { published: 1, failed: 0 }, "bail expiré : repris");
});

test("arrêt propre : stop() attend la fin du cycle en cours", async () => {
  const { transport, relay } = setup();
  transport.connected = true;
  relay.start();
  await relay.stop();
  assert.doesNotThrow(() => relay.start());
  await relay.stop();
});
