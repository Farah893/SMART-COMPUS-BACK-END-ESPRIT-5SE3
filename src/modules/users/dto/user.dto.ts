import { z } from "zod";
import { USER_STATUSES, type Role, type UserStatus } from "../../../shared/constants/index.js";
import { emailField, nameField, roleField } from "../../../shared/validation/fields.js";
import type { User, UserStats } from "../types/user.types.js";

/* ------------------------------ DTO d'entrée ------------------------------ */

export const adminCreateUserDto = z.object({ firstName: nameField, lastName: nameField, email: emailField, role: roleField });
export type AdminCreateUserDto = z.infer<typeof adminCreateUserDto>;

export const updateProfileDto = z.object({
  firstName: nameField,
  lastName: nameField,
  phone: z.string().trim().max(30).optional().or(z.literal("")),
});
export type UpdateProfileDto = z.infer<typeof updateProfileDto>;

export const changePasswordDto = z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128) });
export type ChangePasswordDto = z.infer<typeof changePasswordDto>;

/** Photo : image `data:` uniquement (pas d'URL externe : elle servirait de pixel espion), 100 Ko environ, contenu vérifié. */
const MAX_AVATAR_CHARS = 140_000;
const hasImageSignature = (dataUrl: string): boolean => {
  const start = dataUrl.indexOf(",") + 1;
  const head = Buffer.from(dataUrl.slice(start, start + 32), "base64");
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || webp;
};
export const updateAvatarDto = z.object({
  avatarUrl: z
    .string()
    .max(MAX_AVATAR_CHARS, "Image trop lourde (100 Ko maximum)")
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, "Image invalide")
    .refine(hasImageSignature, "Le contenu n'est pas une image valide")
    .nullable(),
});
export type UpdateAvatarDto = z.infer<typeof updateAvatarDto>;

export const changeRoleDto = z.object({ role: roleField });
export type ChangeRoleDto = z.infer<typeof changeRoleDto>;

export const changeStatusDto = z.object({ status: z.enum(["active", "inactive"]) });
export type ChangeStatusDto = z.infer<typeof changeStatusDto>;

/** Filtres de liste : une valeur inconnue est ignorée (jamais une erreur), comme avant. */
export const listUsersQueryDto = z.object({
  q: z.string().optional().catch(undefined),
  role: roleField.optional().catch(undefined),
  status: z.enum(USER_STATUSES).optional().catch(undefined),
  // Pagination facultative : sans paramètre, le comportement historique est conservé (page 1, jusqu'à 500 comptes).
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type ListUsersQueryDto = z.infer<typeof listUsersQueryDto>;

/* ------------------------------ DTO de sortie ----------------------------- */

/** Contrat JSON du compte, identique au type `UserAccount` du front. */
export interface UserResponse {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: Role;
  status: UserStatus;
  failedAttempts: number;
  lastLoginAt: string | null;
  avatarUrl?: string;
  createdAt?: string;
  mustChangePassword?: true;
}

const iso = (d?: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Frontière avec le front. Jamais de hash, de `_id` ni de champs internes. */
export const toUserResponse = (u: User): UserResponse => ({
  id: u._id,
  firstName: u.firstName,
  lastName: u.lastName,
  email: u.email,
  phone: u.phone,
  role: u.role,
  status: u.status,
  failedAttempts: u.failedAttempts,
  lastLoginAt: iso(u.lastLoginAt),
  avatarUrl: u.avatarUrl,
  createdAt: iso(u.createdAt) ?? undefined,
  ...(u.mustChangePassword && { mustChangePassword: true as const }),
});

export interface UserListResult {
  items: User[];
  stats: UserStats;
  page: number;
  limit: number;
  total: number;
}

/** `stats` reste global (tous les comptes) ; `total` compte les comptes correspondant aux filtres. Champs ajoutés, aucun retiré. */
export const toUserListResponse = ({ items, stats, page, limit, total }: UserListResult) => ({
  items: items.map(toUserResponse),
  stats,
  page,
  limit,
  total,
});

export const toAdminCreatedResponse = ({ account, temporaryPassword }: { account: User; temporaryPassword?: string }) => ({
  account: toUserResponse(account),
  ...(temporaryPassword && { demoTemporaryPassword: temporaryPassword }),
});
