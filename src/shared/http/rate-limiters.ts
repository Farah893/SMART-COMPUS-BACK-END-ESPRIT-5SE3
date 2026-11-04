import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/**
 * Limiteurs de débit par usage (et non un seul quota pour tout /auth) :
 *  - connexion : par IP **et** par couple IP+compte (la force brute sur un compte est freinée sans punir tout un campus
 *    derrière la même adresse) ; seules les connexions échouées comptent ;
 *  - envois de codes/liens et opérations sensibles : quota strict par IP et par destinataire (anti-inondation d'e-mails) ;
 *  - rafraîchissement : large (appelé automatiquement par le front) ;
 *  - changement de mot de passe : par IP et par compte (anti-devinette du mot de passe actuel avec un jeton volé).
 * Le magasin est en mémoire, donc par instance : avec plusieurs instances, brancher un magasin partagé (Redis).
 */
export interface LimiterOptions {
  enabled: boolean;
  windowMs?: number;
  login?: number;
  loginIp?: number;
  sensitive?: number;
  sensitiveIp?: number;
  refresh?: number;
  password?: number;
}

const ip = (req: Request): string => req.ip ?? "inconnue";
const emailOf = (req: Request): string => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";
};

export function createRateLimiters(
  options: LimiterOptions,
): Record<"loginIp" | "login" | "sensitiveIp" | "sensitive" | "refresh" | "password", RequestHandler> {
  const { enabled, windowMs = 15 * 60_000 } = options;
  const make = (limit: number, keyGenerator: (req: Request) => string, skipSuccessfulRequests = false): RequestHandler =>
    enabled
      ? rateLimit({
          windowMs,
          limit,
          keyGenerator,
          skipSuccessfulRequests,
          standardHeaders: true,
          legacyHeaders: false,
          message: { message: "Trop de requêtes, réessayez plus tard", code: "RATE_LIMITED" },
        })
      : (_req, _res, next) => next();
  return {
    loginIp: make(options.loginIp ?? 100, ip, true),
    login: make(options.login ?? 10, (req) => `${ip(req)}|${emailOf(req)}`, true),
    sensitiveIp: make(options.sensitiveIp ?? 60, ip),
    sensitive: make(options.sensitive ?? 10, (req) => `${ip(req)}|${emailOf(req)}`),
    refresh: make(options.refresh ?? 120, ip),
    password: make(options.password ?? 10, (req) => `${ip(req)}|${req.params.id ?? ""}`),
  };
}
