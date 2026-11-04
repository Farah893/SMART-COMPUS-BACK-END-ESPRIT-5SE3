import type { Role, UserStatus } from "../../../shared/constants/index.js";

/**
 * Compte utilisateur : objet simple, indépendant de Mongoose. `_id` = matricule (ex. ETU-2026-0001).
 * Le hash du mot de passe n'est jamais présent sauf demande explicite (`UserWithPassword`).
 */
export interface User {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: Role;
  status: UserStatus;
  failedAttempts: number;
  lastLoginAt: Date | null;
  avatarUrl?: string;
  mustChangePassword: boolean;
  emailVerified: boolean;
  /** Les jetons d'accès émis AVANT cette date (à la seconde) sont refusés. Absent = aucune révocation. */
  tokensValidAfter?: Date;
  /** Verrouillage temporaire après trop d'échecs : le compte se déverrouille seul à cette date. */
  lockedUntil?: Date;
  /** Vrai pour un compte créé par auto-inscription tant que le code e-mail n'a pas été saisi (connexion refusée). */
  verificationPending?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type UserWithPassword = User & { passwordHash: string };

/** Données nécessaires pour créer un compte (le matricule est généré par le service). */
export interface NewUser {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
  emailVerified?: boolean;
  verificationPending?: boolean;
}

/** Champs modifiables ; une valeur `undefined` SUPPRIME le champ (téléphone, photo). */
export type UserPatch = Partial<
  Pick<
    UserWithPassword,
    | "firstName" | "lastName" | "phone" | "avatarUrl" | "role" | "status"
    | "failedAttempts" | "lastLoginAt" | "mustChangePassword" | "emailVerified" | "passwordHash" | "tokensValidAfter" | "lockedUntil" | "verificationPending"
  >
>;

export interface UserFilters {
  q?: string;
  role?: Role;
  status?: UserStatus;
}

export interface UserPage {
  skip: number;
  limit: number;
}

export interface UserStats {
  total: number;
  active: number;
  inactive: number;
  suspended: number;
}
