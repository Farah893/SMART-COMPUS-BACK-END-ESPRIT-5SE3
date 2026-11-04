import { createApp } from "./app.js";
import { seed } from "./bootstrap/seed.js";
import { config } from "./config/index.js";
import { buildContainer } from "./container.js";
import { connectDatabase, disconnectDatabase } from "./infrastructure/database/mongo.js";
import { logger } from "./infrastructure/logging/logger.js";

// Un seul conteneur par processus : c'est celui dont le bus d'événements est connecté ci-dessous.
const container = buildContainer();

// Une erreur non prévue ne doit jamais laisser le processus à moitié vivant : on journalise puis on sort (l'orchestrateur relance).
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "promesse rejetée non gérée");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "exception non interceptée");
  process.exit(1);
});

try {
  await connectDatabase(config.mongoUri, config.mongo);
  logger.info("MongoDB connecté");
  await seed(container);
} catch (err) {
  logger.fatal({ err }, "démarrage impossible : MongoDB injoignable ou amorçage en échec");
  process.exit(1);
}
// Le premier échec de connexion n'est pas fatal : le relais se reconnecte tout seul (backoff) et les événements attendent en base.
await container.eventBus.connect().catch((err) => logger.warn({ err }, "RabbitMQ injoignable au démarrage"));
if (config.rabbit.url) container.outboxRelay.start();

const server = createApp(container).listen(config.port, () =>
  logger.info(`http://localhost:${config.port}  (santé : /health · prêt : /ready · docs : /docs)`),
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(
      `Le port ${config.port} est déjà utilisé par un autre processus. ` +
        `Arrêtez l'autre instance (Ctrl+C dans l'autre terminal) ou changez PORT dans .env, puis relancez.`,
    );
  } else {
    logger.fatal({ err }, "Erreur du serveur HTTP");
  }
  process.exit(1);
});

/**
 * Arrêt progressif :
 *  1. /ready passe à 503 (« DRAINING ») ; /health reste à 200 : le répartiteur retire l'instance du trafic ;
 *  2. attente `SHUTDOWN_DRAIN_MS` (5 s en production) pour qu'il ait le temps de le constater ;
 *  3. fermeture du serveur (les requêtes en cours se terminent), puis relais -> RabbitMQ -> MongoDB, dans cet ordre.
 */
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  container.lifecycle.draining = true;
  logger.info({ signal, drainMs: config.shutdownDrainMs }, "arrêt demandé");
  // Garde-fou : si quelque chose bloque la fermeture, on force la sortie.
  setTimeout(() => process.exit(1), config.shutdownDrainMs + 10_000).unref();
  setTimeout(() => {
    server.close(async () => {
      await container.outboxRelay.stop();
      await container.eventBus.close();
      await disconnectDatabase();
      logger.info("arrêt terminé");
      process.exit(0);
    });
    server.closeIdleConnections(); // ne pas attendre les connexions keep-alive inactives
  }, config.shutdownDrainMs);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
