import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { Router, type Express } from "express";
import { createRateLimiters } from "./shared/http/rate-limiters.js";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { errorHandler, notFoundHandler } from "./shared/middleware/error-handler.js";
import { config } from "./config/index.js";
import { isAllowedOrigin } from "./shared/http/auth-cookies.js";
import { buildContainer, type Container } from "./container.js";
import { openApiSpec } from "./docs/openapi.js";
import { logger } from "./infrastructure/logging/logger.js";
import { httpMetrics } from "./infrastructure/observability/http-metrics.js";
import { createAuthRouter } from "./modules/auth/routes/auth.routes.js";
import { createJwksRouter } from "./modules/auth/routes/jwks.routes.js";
import { createHealthRouter } from "./modules/health/routes/health.routes.js";
import { createMetricsRouter } from "./modules/health/routes/metrics.routes.js";
import { createLoginHistoryRouter } from "./modules/login-history/routes/login-history.routes.js";
import { createRoleRouter } from "./modules/roles/routes/role.routes.js";
import { createUserRouter } from "./modules/users/routes/user.routes.js";

export function createApp(container: Container = buildContainer()): Express {
  const app = express();
  // Proxys de confiance (TRUST_PROXY, 0 par défaut) : sinon un client pourrait falsifier X-Forwarded-For pour contourner
  // les limiteurs et fausser l'historique de connexion. À régler sur le nombre de sauts devant le service (1 pour la Gateway).
  app.set("trust proxy", config.trustProxy);

  // Documentation interactive : montée AVANT helmet (l'interface Swagger a besoin de scripts en ligne que la CSP bloquerait),
  // donc réservée au développement (ENABLE_DOCS=true pour l'activer ailleurs) : elle liste toutes les routes.
  if (config.docsEnabled) {
    app.get("/openapi.json", (_req, res) => void res.json(openApiSpec));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec as object, { customSiteTitle: "SmartCampus user-service" }));
  }

  app.use(helmet());
  // Chaque requête reçoit un identifiant (celui du client/gateway s'il existe), renvoyé en en-tête et présent dans tous les logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        // Valeur du client acceptée seulement si elle est sobre (anti-pollution des journaux), sinon on en génère une.
        const id = typeof incoming === "string" && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      autoLogging: { ignore: (req) => ["/health", "/ready", "/metrics"].includes(req.url ?? "") },
    }),
  );
  // En développement, Vite change de port s'il est occupé (5173 → 5174…) : tout localhost est accepté.
  // En production, seules les origines de CORS_ORIGINS sont autorisées.
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)), credentials: true }));
  app.use(express.json({ limit: "1mb" })); // photo de profil JPEG 256 px en data URL

  app.use(httpMetrics);
  app.use(createHealthRouter(container));
  app.use(createJwksRouter(container));
  app.use(createMetricsRouter({ token: config.metricsToken, isProd: config.isProd }));

  const limit = createRateLimiters({ enabled: !config.isTest });

  // Un seul routeur d'API, monté sur /v1 (version canonique) ET sur / (alias historique : le front et la Gateway
  // actuels n'ont rien à changer). Un seul routeur = un seul limiteur : le quota n'est pas doublé.
  const api = Router();
  // Limiteurs montés AVANT les routeurs (le corps JSON est déjà lu : ils peuvent viser l'adresse e-mail visée).
  api.use("/auth/login", limit.loginIp, limit.login);
  api.use("/auth/refresh", limit.refresh);
  for (const path of ["/auth/register", "/auth/verify-email", "/auth/resend-activation", "/auth/forgot-password", "/auth/reset-password"]) {
    api.use(path, limit.sensitiveIp, limit.sensitive);
  }
  api.use("/users/:id/password", limit.password);
  api.use("/auth", createAuthRouter(container));
  api.use("/users", createUserRouter(container));
  api.use("/roles", createRoleRouter(container));
  api.use("/login-history", createLoginHistoryRouter(container));
  app.use("/v1", api);
  app.use("/", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
