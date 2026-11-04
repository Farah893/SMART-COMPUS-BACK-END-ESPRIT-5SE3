import { Router } from "express";
import { isDatabaseUp } from "../../../infrastructure/database/mongo.js";

interface BusStatus {
  status(): "up" | "down" | "disabled";
}

/** État du cycle de vie du processus, partagé entre l'arrêt (server.ts) et la sonde de disponibilité. */
export interface Lifecycle {
  draining: boolean;
}

/**
 * Deux sondes distinctes (convention Kubernetes / Docker) :
 *  - /health : le processus répond et la base est joignable (« vivant », contrat historique) ;
 *  - /ready  : prêt à recevoir du trafic. Passe à 503 dès que l'arrêt est demandé (« DRAINING ») pour que le
 *              répartiteur cesse d'envoyer des requêtes AVANT la fermeture ; /health reste à 200 pendant ce temps.
 *              Seule la base conditionne le 503 « DOWN » : sans RabbitMQ le service reste utile (les événements
 *              attendent dans la boîte d'envoi), il est donc « dégradé » et non « arrêté ».
 */
export function createHealthRouter({ eventBus, lifecycle }: { eventBus: BusStatus; lifecycle: Lifecycle }): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    const up = isDatabaseUp();
    res.status(up ? 200 : 503).json({ service: "user-service", status: up ? "UP" : "DOWN" });
  });

  router.get("/ready", (_req, res) => {
    const mongo = isDatabaseUp() ? "up" : "down";
    const rabbitmq = eventBus.status();
    const checks = { mongo, rabbitmq };
    if (lifecycle.draining) {
      res.status(503).json({ service: "user-service", status: "DRAINING", checks });
      return;
    }
    const ready = mongo === "up";
    const degraded = ready && rabbitmq === "down";
    res.status(ready ? 200 : 503).json({
      service: "user-service",
      status: !ready ? "DOWN" : degraded ? "DEGRADED" : "UP",
      checks,
    });
  });

  return router;
}
