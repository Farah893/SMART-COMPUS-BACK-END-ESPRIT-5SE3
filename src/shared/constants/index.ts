export const ROLES = ["student", "teacher", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["active", "inactive", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Préfixe de matricule par rôle (ETU-2026-0001). */
export const MATRICULE_PREFIX: Readonly<Record<Role, string>> = { student: "ETU", teacher: "ENS", admin: "ADM" };

export const TOKEN_TYPES = { VERIFY_EMAIL: "verify-email", RESET_PASSWORD: "reset-password" } as const;
export type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES];

/** Événements de domaine publiés sur le bus (clé de routage : `user.<nom>`). */
export const DOMAIN_EVENTS = { USER_CREATED: "UtilisateurCréé", ROLE_CHANGED: "RôleModifié" } as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
