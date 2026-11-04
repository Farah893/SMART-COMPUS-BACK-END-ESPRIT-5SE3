import { pino } from "pino";
import { config } from "../../config/index.js";

/**
 * Logger structuré (JSON en production, lisible en développement, muet en test).
 * Les en-têtes sensibles ne sont jamais écrits.
 */
export const logger = pino({
  level: config.isTest ? "silent" : config.logLevel,
  base: { service: "user-service" },
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'], censor: "[masqué]" },
  ...(config.isProd || config.isTest
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" } } }),
});
