import { Router } from "express";
import type { TokenService } from "../../../shared/ports/index.js";

/**
 * GET /.well-known/jwks.json : clés PUBLIQUES de vérification des jetons (RFC 7517).
 * Les autres services (ou la Gateway) la téléchargent et la mettent en cache ; ils n'ont jamais besoin de la clé privée.
 * Public par construction. Vide en HS256 (développement).
 */
export function createJwksRouter({ tokenService }: { tokenService: TokenService }): Router {
  const router = Router();
  router.get("/.well-known/jwks.json", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300"); // 5 min : laisse le temps de propager une rotation de clé
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.json(tokenService.jwks());
  });
  return router;
}
