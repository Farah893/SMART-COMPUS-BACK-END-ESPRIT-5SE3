import type { CookieOptions, Request, Response } from "express";
import { config } from "../../config/index.js";
import { forbidden } from "../errors/app-error.js";

/**
 * Session par cookies `httpOnly` (le JavaScript de la page ne peut jamais lire les jetons : une faille XSS ne les vole pas).
 *
 * Mode opt-in : seul un client qui envoie `X-Auth-Mode: cookie` reçoit des cookies (et plus de jetons dans le corps).
 * Sans cet en-tête, le comportement historique (JWT dans le corps, en-tête `Authorization: Bearer`) est inchangé :
 * les autres services, Swagger et les scripts continuent de fonctionner.
 */
export const AUTH_MODE_HEADER = "x-auth-mode";
export const ACCESS_COOKIE = "sc_access";
export const REFRESH_COOKIE = "sc_refresh";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Le navigateur joint-il l'un de NOS cookies d'authentification ? (Il le fait tout seul, même depuis un site tiers.) */
export const hasAuthCookie = (req: Request): boolean =>
  readCookie(req, ACCESS_COOKIE) !== undefined || readCookie(req, REFRESH_COOKIE) !== undefined;

export const isCookieMode = (req: Request): boolean => req.get(AUTH_MODE_HEADER) === "cookie";

/** Lecture minimale de l'en-tête `Cookie` (pas de dépendance pour trois lignes). */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Origine autorisée ? Même règle que CORS (liste blanche ; tout localhost seulement hors production). */
const localDev = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
export const isAllowedOrigin = (origin: string): boolean =>
  config.corsOrigins.includes(origin) || (!config.isProd && localDev.test(origin));

/**
 * Protection CSRF d'une requête authentifiée par cookie (le navigateur joint les cookies tout seul, y compris
 * depuis un site tiers). Une requête qui change des données doit :
 *  - porter l'en-tête personnalisé `X-Auth-Mode: cookie` (un site tiers ne peut pas l'envoyer sans pré-vérification CORS,
 *    que la liste blanche d'origines refuse) ;
 *  - et, si le navigateur indique une origine, que cette origine soit autorisée.
 * S'ajoute à `SameSite`, qui n'est pas suffisant seul (sites frères, navigateurs anciens).
 */
export function assertCsrfSafe(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.get("origin");
  if (!isCookieMode(req) || (origin !== undefined && !isAllowedOrigin(origin))) {
    throw forbidden("Requête refusée (protection CSRF)", { code: "CSRF_REJECTED" });
  }
}

const base = (): CookieOptions => ({
  httpOnly: true,
  secure: config.cookies.secure,
  sameSite: config.cookies.sameSite,
  domain: config.cookies.domain,
  path: "/", // le routeur est monté sur « / » ET « /v1 » : un chemin plus étroit raterait l'un des deux
});

/** Durée de vie restante d'un JWT (lue dans `exp`, sans vérification : la signature est contrôlée ailleurs). */
function remainingMs(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { exp?: number };
    return payload.exp ? Math.max(0, payload.exp * 1000 - Date.now()) : undefined;
  } catch {
    return undefined;
  }
}

export function setAuthCookies(res: Response, tokens: { token: string; refreshToken: string }): void {
  res.cookie(ACCESS_COOKIE, tokens.token, { ...base(), maxAge: remainingMs(tokens.token) });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base(), maxAge: config.refreshTtlDays * 86_400_000 });
}

/** Mêmes attributs que lors de la pose, sinon le navigateur conserve le cookie. */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, base());
  res.clearCookie(REFRESH_COOKIE, base());
}
