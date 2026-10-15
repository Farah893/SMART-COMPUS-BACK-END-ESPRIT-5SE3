import { Router } from "express";
import { LoginEvent } from "../models/index.js";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { wrap } from "../utils/errors.js";
import { resultFilter } from "./users.js";

export const historyRouter = Router();

/** GET /login-history?result=success|failure (admin) — historique de tous les comptes */
historyRouter.get("/", authenticate, requireAdmin, wrap(async (req, res) => {
  res.json(await LoginEvent.find(resultFilter(req)).sort({ date: -1 }).limit(500));
}));
