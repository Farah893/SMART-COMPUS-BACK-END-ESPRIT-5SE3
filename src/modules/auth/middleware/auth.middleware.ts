import type { RequestHandler } from "express";
import { forbidden, unauthorized } from "../../../shared/errors/app-error.js";
import type { TokenClaims, TokenService } from "../../../shared/ports/index.js";
import { ACCESS_COOKIE, assertCsrfSafe, hasAuthCookie, readCookie } from "../../../shared/http/auth-cookies.js";
import { asyncHandler } from "../../../shared/middleware/async-handler.js";
import type { UserRepository } from "../../users/repositories/user.repository.js";

export interface AuthMiddleware {
  /** Compte actif, jeton valide. Refuse (403) un compte qui doit encore remplacer son mot de passe temporaire. */
  authenticate: RequestHandler;
  /**
   * Même contrôle, mais laisse passer un compte à mot de passe temporaire. À réserver aux routes qui lui permettent
   * de SORTIR de cet état (changer son mot de passe, lire son profil, se déconnecter) : la liste est dans les routeurs.
   */
  authenticateAllowTemporary: RequestHandler;
  /** Pour un compte à mot de passe temporaire : uniquement SON propre profil (jamais celui d'un autre, même administrateur). */
  ownProfileOnlyWhileTemporary: RequestHandler;
  requireAdmin: RequestHandler;
  selfOrAdmin: RequestHandler;
  onlySelf: RequestHandler;
}

/** Garde d'accès partagée par les routeurs protégés. Construite avec ses dépendances (pas d'import direct de la base). */
export function createAuthMiddleware(deps: { userRepository: UserRepository; tokenService: TokenService }): AuthMiddleware {
  /**
   * Vérifie le JWT puis relit le compte en base : le rôle et le statut qui font foi sont ceux du compte,
   * pas ceux du jeton (un rôle retiré ou un compte désactivé prend effet immédiatement).
   *
   * Aucune décision de sécurité ne dépend ici d'une valeur choisie par l'appelant (URL, méthode, présence d'un en-tête) :
   *  - le contrôle CSRF s'applique dès que le navigateur joint NOS cookies, d'où que vienne le jeton utilisé ;
   *  - l'accès d'un compte à mot de passe temporaire est décidé par la ROUTE (quel garde elle utilise), pas par l'adresse demandée.
   */
  const authenticateWith = (allowTemporaryPassword: boolean): RequestHandler =>
    asyncHandler(async (req, _res, next) => {
      // Les cookies sont ajoutés tout seuls par le navigateur, y compris depuis un site tiers : s'ils sont présents,
      // la requête doit prouver sa légitimité (en-tête personnalisé + origine autorisée) AVANT toute autre chose.
      if (hasAuthCookie(req)) assertCsrfSafe(req);

      // En-tête Bearer d'abord (services, scripts, Swagger), sinon cookie httpOnly du navigateur.
      const header = req.get("authorization") ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
      const token = bearer ?? readCookie(req, ACCESS_COOKIE);
      if (!token) throw unauthorized();

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
      // Mot de passe temporaire : tant qu'il n'est pas changé, le serveur refuse tout, sauf les routes qui appellent
      // `authenticateAllowTemporary` (le front seul ne suffit pas : un client direct contournerait l'écran).
      if (user.mustChangePassword && !allowTemporaryPassword) {
        throw forbidden("Changement de mot de passe obligatoire", { code: "PASSWORD_CHANGE_REQUIRED" });
      }
      req.user = user;
      next();
    });

  const ownProfileOnlyWhileTemporary: RequestHandler = (req, _res, next) =>
    req.user?.mustChangePassword && req.params.id !== req.user._id
      ? next(forbidden("Changement de mot de passe obligatoire", { code: "PASSWORD_CHANGE_REQUIRED" }))
      : next();

  const requireAdmin: RequestHandler = (req, _res, next) =>
    req.user?.role === "admin" ? next() : next(forbidden("Réservé aux administrateurs"));

  /** Soi-même ou administrateur. */
  const selfOrAdmin: RequestHandler = (req, _res, next) =>
    req.user?.role === "admin" || req.user?._id === req.params.id ? next() : next(forbidden());

  /** Soi-même uniquement (mot de passe, photo). */
  const onlySelf: RequestHandler = (req, _res, next) => (req.user?._id === req.params.id ? next() : next(forbidden()));

  return {
    authenticate: authenticateWith(false),
    authenticateAllowTemporary: authenticateWith(true),
    ownProfileOnlyWhileTemporary,
    requireAdmin,
    selfOrAdmin,
    onlySelf,
  };
}
