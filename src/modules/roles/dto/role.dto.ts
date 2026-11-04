import { z } from "zod";
import { roleField } from "../../../shared/validation/fields.js";
import type { PermissionDefinition } from "../constants/permission.catalog.js";
import type { PermissionMatrix } from "../services/role.service.js";

export const setPermissionDto = z.object({ role: roleField, key: z.string().min(1), granted: z.boolean() });
export type SetPermissionDto = z.infer<typeof setPermissionDto>;

export interface PermissionMatrixResponse {
  permissions: readonly PermissionDefinition[];
  matrix: PermissionMatrix;
}

/** { permissions: catalogue, matrix[role][clé] } */
export const toPermissionMatrixResponse = ({ permissions, matrix }: PermissionMatrixResponse): PermissionMatrixResponse => ({
  permissions,
  matrix,
});
