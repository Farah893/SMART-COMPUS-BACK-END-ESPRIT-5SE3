import type { ChannelModel, ConfirmChannel } from "amqplib";
import { logger } from "../logging/logger.js";
import { routingKeyOf, type EventEnvelope } from "./event-envelope.js";
import type { EventTransport } from "./outbox-relay.js";

const log = logger.child({ component: "event-bus" });

/**
 * Transport RabbitMQ : exchange « topic », messages persistants, publication CONFIRMÉE par le courtier.
 * Il ne décide pas quoi publier (c'est la boîte d'envoi) et ne perd rien en cas de panne : `isConnected()` redevient vrai
 * après `connect()`, que le relais rappelle avec backoff.
 */
export class RabbitEventBus implements EventTransport {
  #connection: ChannelModel | null = null;
  #channel: ConfirmChannel | null = null;

  constructor(private readonly options: { url: string; exchange: string }) {}

  /** « disabled » : aucun RABBITMQ_URL ; « down » : configuré mais injoignable. */
  status(): "up" | "down" | "disabled" {
    if (!this.options.url) return "disabled";
    return this.#channel ? "up" : "down";
  }

  isConnected(): boolean {
    return this.#channel !== null;
  }

  async connect(): Promise<void> {
    if (!this.options.url || this.#channel) return;
    const amqp = await import("amqplib");
    const connection = await amqp.connect(this.options.url);
    // Sans écouteur « error », une coupure réseau ferait planter tout le processus.
    connection.on("error", (err: Error) => log.warn({ err }, "connexion RabbitMQ en erreur"));
    connection.on("close", () => {
      log.warn("connexion RabbitMQ fermée");
      this.#channel = null;
      this.#connection = null;
    });
    const channel = await connection.createConfirmChannel();
    channel.on("error", (err: Error) => log.warn({ err }, "canal RabbitMQ en erreur"));
    channel.on("close", () => (this.#channel = null));
    await channel.assertExchange(this.options.exchange, "topic", { durable: true });
    this.#connection = connection;
    this.#channel = channel;
    log.info("bus d'événements connecté");
  }

  /** Résout quand le courtier a ACCUSÉ la réception (ack) ; rejette sur nack ou canal fermé. */
  publish(envelope: EventEnvelope): Promise<void> {
    const channel = this.#channel;
    if (!channel) return Promise.reject(new Error("bus non connecté"));
    return new Promise((resolve, reject) => {
      try {
        channel.publish(
          this.options.exchange,
          routingKeyOf(envelope.name),
          Buffer.from(JSON.stringify(envelope)),
          {
            persistent: true,
            contentType: "application/json",
            messageId: envelope.id,
            type: envelope.name,
            timestamp: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
            headers: { "schema-version": envelope.version },
          },
          (err) => (err ? reject(err) : resolve()),
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  async close(): Promise<void> {
    const connection = this.#connection;
    this.#channel = null;
    this.#connection = null;
    try {
      await connection?.close();
    } catch {
      // déjà fermée
    }
  }
}
