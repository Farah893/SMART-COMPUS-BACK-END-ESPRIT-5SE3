import { Router } from "express";
import { asyncHandler as h } from "../../../shared/middleware/async-handler.js";
import { validate } from "../../../shared/middleware/validate.js";
import type { AuthMiddleware } from "../../auth/middleware/auth.middleware.js";
import { setPermissionDto } from "../dto/role.dto.js";
import type { RoleController } from "../controllers/role.controller.js";

/** Monté sur /roles — réservé aux administrateurs. */
export function createRoleRouter({ roleController: c, auth }: { roleController: RoleController; auth: AuthMiddleware }): Router {
  const router = Router();
  router.use(auth.authenticate, auth.requireAdmin);

  router.get("/permissions", h(c.getPermissions));
  router.put("/permissions", validate(setPermissionDto), h(c.setPermission));
  return router;
}
