/**
 * Erreurs applicatives. Elles décrivent la NATURE de l'échec (non trouvé, conflit, verrouillé…), pas un code HTTP :
 * la traduction en statut HTTP est faite à un seul endroit, le gestionnaire d'erreurs (common/middleware/error-handler.ts).
 */
export type ErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "locked";

/** Détails exposés au client (`code` lisible par le front, compteurs, champs en erreur…). */
export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (m: string, details?: ErrorDetails) => new AppError("bad_request", m, details);
export const unauthorized = (m = "Non authentifié", details?: ErrorDetails) => new AppError("unauthorized", m, details);
export const forbidden = (m = "Accès interdit", details?: ErrorDetails) => new AppError("forbidden", m, details);
export const notFound = (m = "Utilisateur introuvable") => new AppError("not_found", m);
export const conflict = (m: string, details?: ErrorDetails) => new AppError("conflict", m, details);
export const unprocessable = (m: string, details?: ErrorDetails) => new AppError("unprocessable", m, details);
export const locked = (m: string, details?: ErrorDetails) => new AppError("locked", m, details);
