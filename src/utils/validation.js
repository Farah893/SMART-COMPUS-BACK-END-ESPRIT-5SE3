import { z } from "zod";
import { config } from "../config.js";
import { unprocessable } from "./errors.js";

export const ROLES = ["student", "teacher", "admin"];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const emailRe = new RegExp(`^[^\\s@]+@${escape(config.emailDomain)}$`, "i");
export const isInstitutionalEmail = (email) => emailRe.test(email.trim());

/** Même règle que le front : 8 caractères, majuscule, minuscule, chiffre. */
export const isStrongPassword = (pw) => pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw);

const name = z.string().trim().min(1, "Champ requis").max(60);
const email = z.string().trim().toLowerCase().email("Adresse e-mail invalide");
const role = z.enum(ROLES);
const password = z.string().min(8).max(128);

export const schemas = {
  login: z.object({ email, password: z.string().min(1) }),
  // Le rôle éventuellement envoyé est ignoré (zod retire les clés inconnues).
  register: z.object({ firstName: name, lastName: name, email, password }),
  adminCreate: z.object({ firstName: name, lastName: name, email, role }),
  email: z.object({ email }),
  verifyEmail: z.object({ email, code: z.string().regex(/^\d{6}$/) }),
  resetPassword: z.object({ email, token: z.string().min(6), password }),
  profile: z.object({
    firstName: name,
    lastName: name,
    phone: z.string().trim().max(30).optional().or(z.literal("")),
  }),
  changePassword: z.object({ current: z.string().min(1), next: z.string().min(1).max(128) }),
  avatar: z.object({ avatarUrl: z.string().max(700_000).regex(/^(data:image\/(jpeg|png|webp);base64,|https?:\/\/)/).nullable() }),
  role: z.object({ role }),
  status: z.object({ status: z.enum(["active", "inactive"]) }),
  permission: z.object({ role, key: z.string().min(1), granted: z.boolean() }),
};

export const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw unprocessable(first?.message ?? "Données invalides", {
      code: "VALIDATION_ERROR",
      fields: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
};
