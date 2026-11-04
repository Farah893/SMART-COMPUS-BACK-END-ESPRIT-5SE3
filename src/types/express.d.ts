import type {} from "pino-http"; // ajoute `req.id` / `req.log` à la requête
import type { User } from "../modules/users/types/user.types.js";

declare global {
  namespace Express {
    interface Request {
      /** Compte authentifié (relu en base par `authenticate`). */
      user?: User;
      /** DTO d'entrée validé et nettoyé par `validate()`. */
      dto?: unknown;
    }
  }
}

export {};
