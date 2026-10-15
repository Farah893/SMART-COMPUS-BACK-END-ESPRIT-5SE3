import { config } from "../config.js";

/**
 * Bus d'événements de domaine : UtilisateurCréé, RôleModifié.
 * Toujours journalisé ; publié sur RabbitMQ (exchange « topic ») si RABBITMQ_URL est défini.
 */
let channel = null;

export async function connectBus() {
  if (!config.rabbit.url) return;
  try {
    const amqp = await import("amqplib");
    const conn = await amqp.connect(config.rabbit.url);
    channel = await conn.createChannel();
    await channel.assertExchange(config.rabbit.exchange, "topic", { durable: true });
    conn.on("close", () => (channel = null));
    console.info("[user-service] bus d'événements connecté");
  } catch (e) {
    console.warn("[user-service] RabbitMQ indisponible, événements journalisés seulement :", e.message);
  }
}

export function publishEvent(name, payload) {
  console.info(`[user-service] événement publié : ${name}`, JSON.stringify(payload));
  if (!channel) return;
  try {
    channel.publish(
      config.rabbit.exchange,
      `user.${name}`,
      Buffer.from(JSON.stringify({ name, occurredAt: new Date().toISOString(), payload })),
      { persistent: true, contentType: "application/json" },
    );
  } catch (e) {
    console.warn("[user-service] échec de publication :", e.message);
  }
}
