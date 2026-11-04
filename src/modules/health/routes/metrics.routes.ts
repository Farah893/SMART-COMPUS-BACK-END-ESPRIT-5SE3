import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { registry } from "../../../infrastructure/observability/metrics.js";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * GET /metrics (format Prometheus). Jamais exposé publiquement :
 *  - avec METRICS_TOKEN : exige `Authorization: Bearer <jeton>` ;
 *  - sans jeton : disponible en développement seulement ; en production la route répond 404 (désactivée).
 * Prévoir en plus de ne pas la router depuis la Gateway publique.
 */
export function createMetricsRouter({ token, isProd }: { token?: string; isProd: boolean }): Router {
  const router = Router();
  router.get("/metrics", async (req, res) => {
    if (!token && isProd) {
      res.status(404).json({ message: "Route inconnue : GET /metrics" });
      return;
    }
    if (token && !same(req.get("authorization") ?? "", `Bearer ${token}`)) {
      res.status(401).json({ message: "Non authentifié" });
      return;
    }
    res.set("Content-Type", registry.contentType).send(await registry.metrics());
  });
  return router;
}
