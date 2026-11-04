import { Router } from "express";
import { asyncHandler as h } from "../../../shared/middleware/async-handler.js";
import { validate } from "../../../shared/middleware/validate.js";
import { emailDto, loginDto, refreshDto, registerDto, resetPasswordDto, verifyEmailDto } from "../dto/auth.dto.js";
import type { AuthController } from "../controllers/auth.controller.js";
import type { AuthMiddleware } from "../middleware/auth.middleware.js";

/** Monté sur /auth — routes publiques (sans JWT), sauf logout-all. */
export function createAuthRouter({ authController: c, auth }: { authController: AuthController; auth: AuthMiddleware }): Router {
  const router = Router();
  router.post("/login", validate(loginDto), h(c.login));
  router.post("/refresh", validate(refreshDto), h(c.refresh));
  router.post("/logout", validate(refreshDto), h(c.logout));
  router.post("/logout-all", auth.authenticate, h(c.logoutAll));
  router.post("/register", validate(registerDto), h(c.register));
  router.post("/verify-email", validate(verifyEmailDto), h(c.verifyEmail));
  router.post("/resend-activation", validate(emailDto), h(c.resendActivation));
  router.post("/forgot-password", validate(emailDto), h(c.forgotPassword));
  router.post("/reset-password", validate(resetPasswordDto), h(c.resetPassword));
  return router;
}
