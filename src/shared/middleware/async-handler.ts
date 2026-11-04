import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Enveloppe un handler async pour transmettre les erreurs à Express. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
