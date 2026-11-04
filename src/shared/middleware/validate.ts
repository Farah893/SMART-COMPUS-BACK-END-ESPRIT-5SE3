import type { Request, RequestHandler } from "express";
import type { ZodType } from "zod";
import { unprocessable } from "../errors/app-error.js";

/**
 * Valide `req[source]` avec un schéma zod (le DTO d'entrée) et expose le résultat nettoyé dans `req.dto`.
 * Les clés inconnues sont retirées : un client ne peut donc rien injecter hors du contrat.
 */
export const validate =
  (schema: ZodType, source: "body" | "query" = "body"): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const first = result.error.issues[0];
      return next(
        unprocessable(first?.message ?? "Données invalides", {
          code: "VALIDATION_ERROR",
          fields: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        }),
      );
    }
    req.dto = result.data;
    next();
  };

/** Lit le DTO validé par `validate()` avec son type (le schéma de la route garantit sa forme). */
export const dtoOf = <T>(req: Request): T => req.dto as T;
