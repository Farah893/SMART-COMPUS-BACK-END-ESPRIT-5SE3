import { logger } from "../logging/logger.js";
import { routingKeyOf, type EventEnvelope } from "./event-envelope.js";
import type { OutboxRepository } from "./outbox.repository.js";

const log = logger.child({ component: "outbox-relay" });

/** Ce que le relais attend du bus : état de connexion, (re)connexion, et publication CONFIRMÉE par le courtier. */
export interface EventTransport {
  isConnected(): boolean;
  connect(): Promise<void>;
  publish(envelope: EventEnvelope): Promise<void>;
  close(): Promise<void>;
}

export interface RelayOptions {
  pollMs: number;
  batchSize: number;
  /** Durée de réservation d'un événement : au-delà, un autre relais peut le reprendre (relais planté). */
  leaseMs: number;
  retentionMs: number;
  /** Plafond du backoff exponentiel (nouvelle tentative d'un événement, reconnexion au bus). */
  maxBackoffMs: number;
  /** Horloge injectable pour les tests. */
  now?: () => Date;
}

/**
 * Relais de la boîte d'envoi : lit les événements en attente et les publie sur le bus, « au moins une fois »
 * (les consommateurs dédupliquent grâce à `id`). Robuste aux pannes : reconnexion automatique avec backoff,
 * nouvelle tentative avec backoff par événement, reprise des événements d'un relais planté grâce au bail.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = true;
  private reconnectDelay = 0;
  private nextReconnectAt = 0;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly transport: EventTransport,
    private readonly options: RelayOptions,
  ) {}

  private now = () => (this.options.now ?? (() => new Date()))();

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.running = this.runOnce()
        .then(() => undefined)
        .catch((err) => log.error({ err }, "cycle du relais en échec"))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(loop, this.options.pollMs);
        });
    };
    loop();
  }

  /** Arrête le relais en laissant finir le cycle en cours (aucun événement abandonné à mi-publication). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private backoff(attempts: number): number {
    return Math.min(this.options.maxBackoffMs, 1000 * 2 ** Math.min(attempts, 16));
  }

  /** Un cycle : (re)connexion si besoin, puis publication d'un lot. Public pour être testable sans minuterie. */
  async runOnce(): Promise<{ published: number; failed: number }> {
    const now = this.now();
    if (!this.transport.isConnected()) {
      if (now.getTime() < this.nextReconnectAt) return { published: 0, failed: 0 };
      try {
        await this.transport.connect();
      } catch (err) {
        log.warn({ err }, "bus injoignable");
      }
      if (!this.transport.isConnected()) {
        this.reconnectDelay = Math.min(this.options.maxBackoffMs, Math.max(1000, this.reconnectDelay * 2));
        this.nextReconnectAt = now.getTime() + this.reconnectDelay;
        return { published: 0, failed: 0 }; // rien n'est réservé tant que le bus est absent : les événements restent intacts
      }
      this.reconnectDelay = 0;
      this.nextReconnectAt = 0;
    }

    let published = 0;
    let failed = 0;
    const batch = await this.outbox.claimBatch(this.options.batchSize, this.options.leaseMs, now);
    for (const e of batch) {
      const envelope: EventEnvelope = {
        id: e.eventId, name: e.name, version: e.version, occurredAt: e.occurredAt.toISOString(), payload: e.payload,
      };
      try {
        await this.transport.publish(envelope);
        await this.outbox.markPublished(e.eventId, this.now(), this.options.retentionMs);
        published++;
      } catch (err) {
        failed++;
        const next = new Date(this.now().getTime() + this.backoff(e.attempts));
        await this.outbox.markFailed(e.eventId, err instanceof Error ? err.message : String(err), next);
        log.warn({ err, eventId: e.eventId, attempts: e.attempts, retryAt: next }, "publication en échec, nouvelle tentative planifiée");
        break; // on conserve l'ordre : les suivants attendent le prochain cycle
      }
    }
    return { published, failed };
  }
}

export { routingKeyOf };
