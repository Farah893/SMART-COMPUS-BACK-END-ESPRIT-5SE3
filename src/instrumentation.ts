/**
 * Traces distribuées (OpenTelemetry). À charger AVANT l'application : `node --import ./dist/instrumentation.js dist/server.js`.
 * (En ESM, sans ce chargement préalable rien n'est instrumenté et aucune erreur n'est signalée.)
 *
 * Désactivé par défaut : ne s'active que si OTEL_EXPORTER_OTLP_ENDPOINT est défini (export OTLP/HTTP vers un collecteur)
 * ou OTEL_TRACES_EXPORTER=console (affichage local). Variables standard OTEL_* respectées (OTEL_SERVICE_NAME, OTEL_SDK_DISABLED…).
 * Chaque requête produit une trace : span HTTP → Express → MongoDB / RabbitMQ.
 */
import { register } from "node:module";

const wanted = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) || process.env.OTEL_TRACES_EXPORTER === "console";

if (wanted && process.env.OTEL_SDK_DISABLED !== "true") {
  // Hook ESM (import-in-the-middle) : permet d'instrumenter les modules importés avec `import`.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [{ NodeSDK }, { HttpInstrumentation }, { ExpressInstrumentation }, { MongoDBInstrumentation }, { AmqplibInstrumentation }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-express"),
      import("@opentelemetry/instrumentation-mongodb"),
      import("@opentelemetry/instrumentation-amqplib"),
    ]);

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "user-service",
    instrumentations: [
      // Les sondes et les métriques n'ont pas besoin de traces (bruit, volume).
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => ["/health", "/ready", "/metrics"].includes(req.url ?? "") }),
      new ExpressInstrumentation(),
      new MongoDBInstrumentation(),
      new AmqplibInstrumentation(),
    ],
  });
  sdk.start();

  // Vide les spans en attente à l'arrêt, sans interférer avec l'arrêt de l'application.
  process.once("SIGTERM", () => void sdk.shutdown().catch(() => undefined));
}
