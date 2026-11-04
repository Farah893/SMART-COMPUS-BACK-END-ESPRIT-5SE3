import type { Request } from "express";
import { unauthorized } from "../errors/app-error.js";
import type { User } from "../../modules/users/types/user.types.js";

/** Ce que les services ont besoin de savoir de la requête HTTP, sans dépendre d'Express. */
export interface RequestContext {
  ip: string;
  userAgent: string;
}

export const requestContext = (req: Request): RequestContext => ({
  ip: (req.ip ?? "").replace("::ffff:", ""),
  userAgent: req.get("user-agent") ?? "",
});

/** Compte authentifié de la requête (les routes protégées passent toutes par `authenticate`). */
export const currentUser = (req: Request): User => {
  if (!req.user) throw unauthorized();
  return req.user;
};
