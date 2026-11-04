import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, type ErrorKind } from "../errors/app-error.js";
import { logger } from "../../infrastructure/logging/logger.js";

/** Seul endroit qui traduit la nature d'une erreur applicative en statut HTTP. */
export const STATUS_BY_KIND: Readonly<Record<ErrorKind, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  locked: 423,
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ message: `Route inconnue : ${req.method} ${req.path}` });
};

interface ParserError {
  type?: string;
  code?: number;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(STATUS_BY_KIND[err.kind]).json({ message: err.message, ...err.details });
    return;
  }
  const { type, code } = (err ?? {}) as ParserError;
  if (type === "entity.parse.failed") res.status(400).json({ message: "JSON invalide" });
  else if (type === "entity.too.large") res.status(413).json({ message: "Corps de requête trop volumineux" });
  else if (code === 11000) res.status(409).json({ message: "Un compte existe déjà avec cette adresse", code: "EMAIL_EXISTS" });
  else {
    // Erreur inattendue : le détail va dans les journaux (avec l'identifiant de requête), jamais au client.
    logger.error({ err, reqId: req.id }, "erreur non gérée");
    res.status(500).json({ message: "Erreur interne du serveur" });
  }
};
