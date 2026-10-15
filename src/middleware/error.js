import { HttpError } from "../utils/errors.js";

export const notFoundHandler = (req, res) => res.status(404).json({ message: `Route inconnue : ${req.method} ${req.path}` });

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, ...err.extra });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ message: "JSON invalide" });
  if (err?.type === "entity.too.large") return res.status(413).json({ message: "Corps de requête trop volumineux" });
  if (err?.code === 11000) return res.status(409).json({ message: "Un compte existe déjà avec cette adresse", code: "EMAIL_EXISTS" });
  console.error("[user-service]", err);
  res.status(500).json({ message: "Erreur interne du serveur" });
}
