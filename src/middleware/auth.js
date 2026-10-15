import { User } from "../models/index.js";
import { forbidden, unauthorized, wrap } from "../utils/errors.js";
import { verifyToken } from "../utils/security.js";

/**
 * Vérifie le JWT puis relit le compte en base : le rôle et le statut qui font foi sont ceux du compte,
 * pas ceux du jeton (un rôle retiré ou un compte désactivé prend effet immédiatement).
 */
export const authenticate = wrap(async (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let claims;
  try {
    claims = verifyToken(token);
  } catch {
    throw unauthorized("Session expirée ou invalide", { code: "INVALID_TOKEN" });
  }
  const user = await User.findById(claims.sub);
  if (!user || user.status !== "active") throw unauthorized("Compte indisponible", { code: "ACCOUNT_UNAVAILABLE" });
  req.user = user;
  next();
});

export const requireAdmin = (req, _res, next) =>
  req.user?.role === "admin" ? next() : next(forbidden("Réservé aux administrateurs"));

/** Soi-même ou administrateur. */
export const selfOrAdmin = (req, _res, next) =>
  req.user.role === "admin" || req.user._id === req.params.id ? next() : next(forbidden());
