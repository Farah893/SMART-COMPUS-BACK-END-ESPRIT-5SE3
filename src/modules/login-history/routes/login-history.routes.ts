import { Router } from "express";
import { asyncHandler as h } from "../../../shared/middleware/async-handler.js";
import { validate } from "../../../shared/middleware/validate.js";
import type { AuthMiddleware } from "../../auth/middleware/auth.middleware.js";
import type { LoginHistoryController } from "../controllers/login-history.controller.js";
import { loginHistoryQueryDto } from "../dto/login-history.dto.js";

/** Monté sur /login-history (admin). L'historique d'un seul compte est servi par /users/:id/login-history. */
export function createLoginHistoryRouter({ loginHistoryController: c, auth }: { loginHistoryController: LoginHistoryController; auth: AuthMiddleware }): Router {
  const router = Router();
  router.get("/", auth.authenticate, auth.requireAdmin, validate(loginHistoryQueryDto, "query"), h(c.all));
  return router;
}
