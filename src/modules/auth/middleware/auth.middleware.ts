import type { RequestHandler } from "express";
import { forbidden, unauthorized } from "../../../shared/errors/app-error.js";
import type { TokenClaims, TokenService } from "../../../shared/ports/index.js";
import { ACCESS_COOKIE, assertCsrfSafe, readCookie } from "../../../shared/http/auth-cookies.js";
import { asyncHandler } from "../../../shared/middleware/async-handler.js";
import type { UserRepository } from "../../users/repositories/user.repository.js";

export interface AuthMiddleware {
  authenticate: RequestHandler;
  requireAdmin: RequestHandler;
  selfOrAdmin: RequestHandler;
  onlySelf: RequestHandler;
}

/** Routes permises à un compte qui doit encore remplacer son mot de passe temporaire (avec ou sans préfixe /v1). */
function isAllowedWhileTemporary(method: string, originalUrl: string, userId: string): boolean {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "");
  const own = `/users/${userId}`;
  return (
    (method === "PUT" && path === `${own}/password`) ||
    (method === "GET" && path === own) ||
    (method === "POST" && path === "/auth/logout-all")
  );
}

/** Garde d'accès partagée par les routeurs protégés. Construite avec ses dépendances (pas d'import direct de la base). */
export function createAuthMiddleware(deps: { userRepository: UserRepository; tokenService: TokenService }): AuthMiddleware {
  /**
   * Vérifie le JWT puis relit le compte en base : le rôle et le statut qui font foi sont ceux du compte,
   * pas ceux du jeton (un rôle retiré ou un compte désactivé prend effet immédiatement).
   */
  const authenticate = asyncHandler(async (req, _res, next) => {
    // En-tête Bearer d'abord (services, scripts, Swagger), sinon cookie httpOnly du navigateur.
    const header = req.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const cookie = bearer ? undefined : readCookie(req, ACCESS_COOKIE);
    const token = bearer ?? cookie;
    if (!token) throw unauthorized();
    // Le navigateur joint les cookies tout seul : une requête authentifiée ainsi doit être protégée contre le CSRF.
    if (cookie) assertCsrfSafe(req);
    let claims: TokenClaims;
    try {
      claims = deps.tokenService.verify(token);
    } catch {
      throw unauthorized("Session expirée ou invalide", { code: "INVALID_TOKEN" });
    }
    const user = await deps.userRepository.findById(claims.sub);
    if (!user || user.status !== "active") throw unauthorized("Compte indisponible", { code: "ACCOUNT_UNAVAILABLE" });
    // Révocation : un jeton émis strictement AVANT la date de révocation (comparée à la seconde) est refusé.
    // Compte sans `tokensValidAfter` (cas de tous les comptes existants) : aucune révocation.
    if (user.tokensValidAfter && claims.iat !== undefined && claims.iat < Math.floor(new Date(user.tokensValidAfter).getTime() / 1000)) {
      throw unauthorized("Session révoquée, reconnectez-vous", { code: "SESSION_REVOKED" });
    }
    // Mot de passe temporaire : tant qu'il n'est pas changé, le serveur n'autorise QUE le changement de mot de passe,
    // la lecture de son propre profil et la déconnexion (le front seul ne suffit pas : un client direct contournerait l'écran).
    if (user.mustChangePassword && !isAllowedWhileTemporary(req.method, req.originalUrl, user._id)) {
      throw forbidden("Changement de mot de passe obligatoire", { code: "PASSWORD_CHANGE_REQUIRED" });
    }
    req.user = user;
    next();
  });

  const requireAdmin: RequestHandler = (req, _res, next) =>
    req.user?.role === "admin" ? next() : next(forbidden("Réservé aux administrateurs"));

  /** Soi-même ou administrateur. */
  const selfOrAdmin: RequestHandler = (req, _res, next) =>
    req.user?.role === "admin" || req.user?._id === req.params.id ? next() : next(forbidden());

  /** Soi-même uniquement (mot de passe, photo). */
  const onlySelf: RequestHandler = (req, _res, next) => (req.user?._id === req.params.id ? next() : next(forbidden()));

  return { authenticate, requireAdmin, selfOrAdmin, onlySelf };
}
