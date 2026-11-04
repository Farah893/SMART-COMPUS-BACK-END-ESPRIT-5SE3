import { z } from "zod";
import type { Role } from "../../../shared/constants/index.js";
import { fullName } from "../../../shared/utils/full-name.js";
import { emailField, nameField, passwordField } from "../../../shared/validation/fields.js";
import type { User } from "../../users/types/user.types.js";

/* ------------------------------ DTO d'entrée ------------------------------ */

export const loginDto = z.object({ email: emailField, password: z.string().min(1) });
export type LoginDto = z.infer<typeof loginDto>;

// Pas de champ `role` : zod retire les clés inconnues, donc un client ne peut pas s'inscrire comme admin.
export const registerDto = z.object({ firstName: nameField, lastName: nameField, email: emailField, password: passwordField });
export type RegisterDto = z.infer<typeof registerDto>;

export const emailDto = z.object({ email: emailField });

// Optionnel dans le corps : en mode cookie, le jeton de rafraîchissement vient du cookie `sc_refresh`.
export const refreshDto = z.object({ refreshToken: z.string().min(20).max(200).optional() });
export type RefreshBody = z.infer<typeof refreshDto>;
/** Ce que le service attend : un jeton, d'où qu'il vienne (corps ou cookie). */
export type RefreshDto = { refreshToken: string };
export type EmailDto = z.infer<typeof emailDto>;

export const verifyEmailDto = z.object({ email: emailField, code: z.string().regex(/^\d{6}$/) });
export type VerifyEmailDto = z.infer<typeof verifyEmailDto>;

export const resetPasswordDto = z.object({ email: emailField, token: z.string().min(6), password: passwordField });
export type ResetPasswordDto = z.infer<typeof resetPasswordDto>;

/* ------------------------------ DTO de sortie ----------------------------- */

export interface LoginResponse {
  token: string;
  /** Jeton de rafraîchissement (champ ajouté ; le front peut l'ignorer). */
  refreshToken: string;
  user: { id: string; name: string; email: string; role: Role; avatarUrl?: string; mustChangePassword?: true };
}

/** Réponse de POST /auth/login : le jeton et l'identité minimale dont le front a besoin. */
export const toLoginResponse = ({ token, refreshToken, user }: { token: string; refreshToken: string; user: User }): LoginResponse => ({
  token,
  refreshToken,
  user: {
    id: user._id,
    name: fullName(user),
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl,
    mustChangePassword: user.mustChangePassword ? true : undefined,
  },
});

/** Réponse en mode cookie : les jetons sont dans des cookies `httpOnly`, jamais dans le corps. */
export const toSessionResponse = (result: { token: string; refreshToken: string; user: User }): Omit<LoginResponse, "token" | "refreshToken"> => {
  return { user: toLoginResponse(result).user };
};

export const OK_RESPONSE = Object.freeze({ ok: true });
