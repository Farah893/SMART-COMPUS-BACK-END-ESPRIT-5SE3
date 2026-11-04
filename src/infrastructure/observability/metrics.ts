import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Métriques Prometheus. Définies UNE fois au niveau du module (jamais dans buildContainer/createApp, sinon
 * « metric already registered » dès que deux applications existent dans le même processus).
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: "user-service" });
collectDefaultMetrics({ register: registry }); // CPU, mémoire, boucle d'événements, GC…

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Durée des requêtes HTTP",
  // `route` est le GABARIT de la route (/users/:id), jamais l'URL réelle : les matricules feraient exploser la cardinalité.
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const loginAttempts = new Counter({
  name: "auth_login_attempts_total",
  help: "Tentatives de connexion enregistrées, par résultat",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const domainEventsQueued = new Counter({
  name: "domain_events_queued_total",
  help: "Événements de domaine inscrits dans la boîte d'envoi",
  labelNames: ["event"] as const,
  registers: [registry],
});

/** Jauge des événements en attente d'envoi (calculée à chaque lecture de /metrics). Idempotente. */
export function registerOutboxGauge(countPending: () => Promise<number>): void {
  if (registry.getSingleMetric("outbox_pending_events")) return;
  new Gauge({
    name: "outbox_pending_events",
    help: "Événements en attente dans la boîte d'envoi (une valeur qui croît = bus injoignable ou relais arrêté)",
    registers: [registry],
    async collect() {
      try {
        this.set(await countPending());
      } catch {
        // Lecture impossible (base indisponible) : on laisse la dernière valeur plutôt que de casser /metrics.
      }
    },
  });
}
