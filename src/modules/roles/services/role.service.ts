import { ROLES, type Role } from "../../../shared/constants/index.js";
import { forbidden, unprocessable } from "../../../shared/errors/app-error.js";
import { DEFAULT_GRANTS, PERMISSIONS, type PermissionDefinition } from "../constants/permission.catalog.js";
import type { PermissionRepository } from "../repositories/permission.repository.js";
import type { SetPermissionDto } from "../dto/role.dto.js";

export type PermissionMatrix = Record<Role, Record<string, boolean>>;

export class RoleService {
  constructor(private readonly permissions: PermissionRepository) {}

  seedDefaultPermissions(): Promise<void> {
    return this.permissions.insertMissing(
      ROLES.flatMap((role) => PERMISSIONS.map(({ key }) => ({ role, key, granted: DEFAULT_GRANTS[role].includes(key) }))),
    );
  }

  /** matrix[role][clé] : tout est initialisé à `false`, puis surchargé par la base. */
  async getMatrix(): Promise<{ permissions: readonly PermissionDefinition[]; matrix: PermissionMatrix }> {
    const rows = await this.permissions.findAll();
    const matrix = Object.fromEntries(
      ROLES.map((r) => [r, Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]))]),
    ) as PermissionMatrix;
    for (const { role, key, granted } of rows) if (matrix[role] && key in matrix[role]) matrix[role][key] = granted;
    return { permissions: PERMISSIONS, matrix };
  }

  async setPermission({ role, key, granted }: SetPermissionDto): Promise<void> {
    if (!PERMISSIONS.some((p) => p.key === key)) throw unprocessable("Permission inconnue", { code: "UNKNOWN_PERMISSION" });
    if (role === "admin" && key.startsWith("users.")) {
      throw forbidden("Les droits d'administration des utilisateurs sont verrouillés");
    }
    await this.permissions.setGranted(role, key, granted);
  }
}
