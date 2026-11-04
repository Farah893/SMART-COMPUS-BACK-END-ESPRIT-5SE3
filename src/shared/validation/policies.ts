import { config } from "../../config/index.js";

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const institutionalEmail = new RegExp(`^[^\\s@]+@${escapeRegExp(config.emailDomain)}$`, "i");
export const isInstitutionalEmail = (email: string): boolean => institutionalEmail.test(email.trim());

/** Même règle que le front : 8 caractères, majuscule, minuscule, chiffre. */
export const isStrongPassword = (pw: string): boolean =>
  pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw);
