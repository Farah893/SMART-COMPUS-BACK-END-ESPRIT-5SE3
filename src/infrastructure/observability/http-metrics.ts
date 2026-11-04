import type { RequestHandler } from "express";
import { httpRequestDuration } from "./metrics.js";

/** Gabarit de route pour l'étiquette `route` : /v1 et l'alias historique partagent les mêmes séries ; 404 = « unmatched ». */
export function routeLabel(baseUrl: string, routePath?: string): string {
  if (routePath === undefined) return "unmatched";
  const full = `${baseUrl}${routePath}`.replace(/^\/v1(?=\/|$)/, "");
  return full.length > 1 ? full.replace(/\/$/, "") : full || "/";
}

export const httpMetrics: RequestHandler = (req, res, next) => {
  const stop = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const routePath = typeof req.route?.path === "string" ? req.route.path : undefined;
    stop({ method: req.method, route: routeLabel(req.baseUrl, routePath), status_code: String(res.statusCode) });
  });
  next();
};
