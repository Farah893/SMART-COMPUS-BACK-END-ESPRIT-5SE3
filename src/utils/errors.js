/** Erreur HTTP normalisée : le front lit `message` et `code` (et `details` pour 423/401). */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (m, extra) => new HttpError(400, m, extra);
export const unauthorized = (m = "Non authentifié", extra) => new HttpError(401, m, extra);
export const forbidden = (m = "Accès interdit", extra) => new HttpError(403, m, extra);
export const notFound = (m = "Utilisateur introuvable") => new HttpError(404, m);
export const conflict = (m, extra) => new HttpError(409, m, extra);
export const unprocessable = (m, extra) => new HttpError(422, m, extra);

/** Enveloppe un handler async pour transmettre les erreurs à Express. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
