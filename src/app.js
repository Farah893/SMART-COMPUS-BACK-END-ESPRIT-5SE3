import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { historyRouter } from "./routes/history.js";
import { rolesRouter } from "./routes/roles.js";
import { usersRouter } from "./routes/users.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // derrière l'API Gateway : IP réelle dans l'historique de connexion
  app.use(helmet());
  // En développement, Vite change de port s'il est occupé (5173 → 5174…) : tout localhost est accepté.
  // En production, seules les origines de CORS_ORIGINS sont autorisées.
  const localDev = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
  const allowed = (origin) => config.corsOrigins.includes(origin) || (!config.isProd && localDev.test(origin));
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowed(origin)), credentials: true }));
  app.use(express.json({ limit: "1mb" })); // photo de profil JPEG 256 px en data URL
  if (config.isProd || process.env.NODE_ENV !== "test") app.use(morgan("dev"));

  app.get("/health", (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ service: "user-service", status: up ? "UP" : "DOWN" });
  });

  // Protection contre la force brute sur les routes publiques (en plus du verrouillage de compte).
  app.use("/auth", rateLimit({ windowMs: 15 * 60_000, limit: 100, standardHeaders: true, legacyHeaders: false, message: { message: "Trop de requêtes, réessayez plus tard" } }), authRouter);
  app.use("/users", usersRouter);
  app.use("/roles", rolesRouter);
  app.use("/login-history", historyRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
