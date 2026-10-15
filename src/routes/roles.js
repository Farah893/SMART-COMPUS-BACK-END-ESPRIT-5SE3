import { Router } from "express";
import { Permission } from "../models/index.js";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { PERMISSIONS, permissionMatrix } from "../services/permissions.js";
import { forbidden, unprocessable, wrap } from "../utils/errors.js";
import { parse, schemas } from "../utils/validation.js";

export const rolesRouter = Router();
rolesRouter.use(authenticate, requireAdmin);

/** GET /roles/permissions → { permissions, matrix[role][key] } */
rolesRouter.get("/permissions", wrap(async (_req, res) => {
  res.json({ permissions: PERMISSIONS, matrix: await permissionMatrix() });
}));

/** PUT /roles/permissions — { role, key, granted } */
rolesRouter.put("/permissions", wrap(async (req, res) => {
  const { role, key, granted } = parse(schemas.permission, req.body);
  if (!PERMISSIONS.some((p) => p.key === key)) throw unprocessable("Permission inconnue", { code: "UNKNOWN_PERMISSION" });
  if (role === "admin" && key.startsWith("users.")) throw forbidden("Les droits d'administration des utilisateurs sont verrouillés");
  await Permission.updateOne({ role, key }, { granted }, { upsert: true });
  res.status(204).end();
}));

