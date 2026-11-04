import { Router } from "express";
import { asyncHandler as h } from "../../../shared/middleware/async-handler.js";
import { validate } from "../../../shared/middleware/validate.js";
import type { AuthMiddleware } from "../../auth/middleware/auth.middleware.js";
import type { LoginHistoryController } from "../../login-history/controllers/login-history.controller.js";
import { loginHistoryQueryDto } from "../../login-history/dto/login-history.dto.js";
import {
  adminCreateUserDto, changePasswordDto, changeRoleDto, changeStatusDto,
  listUsersQueryDto, updateAvatarDto, updateProfileDto,
} from "../dto/user.dto.js";
import type { UserController } from "../controllers/user.controller.js";

interface Deps {
  userController: UserController;
  loginHistoryController: LoginHistoryController;
  auth: AuthMiddleware;
}

/** Monté sur /users — toutes les routes exigent un JWT valide. */
export function createUserRouter({ userController: c, loginHistoryController: history, auth }: Deps): Router {
  const router = Router();

  // SEULES routes ouvertes à un compte dont le mot de passe est encore temporaire (avec la déconnexion, dans le routeur d'auth) :
  // lire SON profil et changer SON mot de passe. Le choix est fait ICI, route par route, jamais d'après l'adresse demandée.
  router.get("/:id", auth.authenticateAllowTemporary, auth.ownProfileOnlyWhileTemporary, auth.selfOrAdmin, h(c.get));
  router.put("/:id/password", auth.authenticateAllowTemporary, auth.onlySelf, validate(changePasswordDto), h(c.changePassword));

  // Toutes les autres : comptes à mot de passe définitif uniquement.
  router.use(auth.authenticate);

  router.post("/", auth.requireAdmin, validate(adminCreateUserDto), h(c.create));
  router.get("/", auth.requireAdmin, validate(listUsersQueryDto, "query"), h(c.list));

  router.put("/:id", auth.selfOrAdmin, validate(updateProfileDto), h(c.updateProfile));
  router.put("/:id/avatar", auth.onlySelf, validate(updateAvatarDto), h(c.updateAvatar));
  router.put("/:id/role", auth.requireAdmin, validate(changeRoleDto), h(c.changeRole));
  router.patch("/:id/status", auth.requireAdmin, validate(changeStatusDto), h(c.changeStatus));
  router.delete("/:id", auth.requireAdmin, h(c.remove));

  router.get("/:id/login-history", auth.selfOrAdmin, validate(loginHistoryQueryDto, "query"), h(history.forUser));
  return router;
}
