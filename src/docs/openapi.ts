import { toJSONSchema, type ZodType } from "zod";
import { adminCreateUserDto, changePasswordDto, changeRoleDto, changeStatusDto, updateAvatarDto, updateProfileDto } from "../modules/users/dto/user.dto.js";
import { emailDto, loginDto, refreshDto, registerDto, resetPasswordDto, verifyEmailDto } from "../modules/auth/dto/auth.dto.js";
import { setPermissionDto } from "../modules/roles/dto/role.dto.js";

/**
 * Contrat OpenAPI 3 du service. Les corps de requête sont générés depuis les DTO zod : la validation à l'exécution
 * et la documentation partagent la même source, elles ne peuvent donc pas diverger.
 */
const schemaOf = (dto: ZodType) => toJSONSchema(dto, { target: "openapi-3.0", io: "input" });
const body = (dto: ZodType) => ({ required: true, content: { "application/json": { schema: schemaOf(dto) } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (description: string, schema: object) => ({ description, content: { "application/json": { schema } } });
const err = (description: string) => json(description, ref("Error"));

const secured = [{ bearerAuth: [] }];
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", example: "ETU-2026-0001" }, description: "Matricule" };
const resultQuery = { name: "result", in: "query", schema: { type: "string", enum: ["success", "failure"] } };

const standardErrors = { "401": err("Non authentifié / jeton invalide"), "403": err("Accès interdit") };

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "SmartCampus — user-service",
    version: "1.0.0",
    description:
      "Comptes, authentification JWT, rôles et permissions, historique de connexion.\n\n" +
      "Les erreurs ont toutes la forme `{ message, code?, ... }`. Le rôle et le statut qui font foi sont ceux relus en base à chaque requête.",
  },
  servers: [
    { url: "/v1", description: "Version canonique" },
    { url: "/", description: "Alias historique (identique à /v1)" },
  ],
  tags: [
    { name: "Auth", description: "Routes publiques" },
    { name: "Users", description: "Comptes (JWT requis)" },
    { name: "Roles", description: "Matrice des permissions (admin)" },
    { name: "History", description: "Historique de connexion" },
    { name: "Ops", description: "Sondes de santé" },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      Error: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          code: { type: "string", example: "INVALID_CREDENTIALS" },
          fields: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
        },
      },
      Ok: { type: "object", properties: { ok: { type: "boolean", example: true } } },
      User: {
        type: "object",
        properties: {
          id: { type: "string", example: "ETU-2026-0001" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          role: { type: "string", enum: ["student", "teacher", "admin"] },
          status: { type: "string", enum: ["active", "inactive", "suspended"] },
          failedAttempts: { type: "integer" },
          lastLoginAt: { type: "string", format: "date-time", nullable: true },
          avatarUrl: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          mustChangePassword: { type: "boolean", description: "Présent (true) tant que le mot de passe temporaire n'a pas été changé" },
        },
      },
      UserStats: {
        type: "object",
        properties: { total: { type: "integer" }, active: { type: "integer" }, inactive: { type: "integer" }, suspended: { type: "integer" } },
      },
      LoginEvent: {
        type: "object",
        properties: {
          id: { type: "string" }, userId: { type: "string" }, userName: { type: "string" },
          date: { type: "string", format: "date-time" }, ip: { type: "string" }, device: { type: "string" }, success: { type: "boolean" },
        },
      },
    },
  },
  paths: {
    "/auth/login": {
      post: {
        tags: ["Auth"], summary: "Connexion", requestBody: body(loginDto),
        responses: {
          "200": json("Jeton et identité", {
            type: "object",
            properties: {
              token: { type: "string" },
              refreshToken: { type: "string", description: "Jeton de rafraîchissement (rotation à chaque usage)" },
              user: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, role: { type: "string" }, avatarUrl: { type: "string" }, mustChangePassword: { type: "boolean" } } },
            },
          }),
          "401": err("Identifiants invalides (`failedAttempts` et `max` indiqués)"),
          "403": err("Compte désactivé (`ACCOUNT_INACTIVE`)"),
          "423": err("Compte suspendu après trop d'échecs (`ACCOUNT_LOCKED`)"),
          "422": err("Données invalides"),
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"], summary: "Échanger un jeton de rafraîchissement (rotation : l'ancien est consommé)", requestBody: body(refreshDto),
        responses: {
          "200": json("Nouveau jeton d'accès et nouveau jeton de rafraîchissement", { type: "object", properties: { token: { type: "string" }, refreshToken: { type: "string" }, user: { type: "object" } } }),
          "401": err("`INVALID_REFRESH_TOKEN` (inconnu, expiré ou rejoué : la famille est alors révoquée)"),
        },
      },
    },
    "/auth/logout": {
      post: { tags: ["Auth"], summary: "Terminer la session portant ce jeton (idempotent)", requestBody: body(refreshDto), responses: { "200": json("OK", ref("Ok")) } },
    },
    "/auth/logout-all": {
      post: {
        tags: ["Auth"], summary: "Déconnecter le compte partout (sessions longues + jetons d'accès déjà émis)", security: secured,
        responses: { "200": json("OK", ref("Ok")), "401": err("Non authentifié") },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Auth"], summary: "Inscription publique (toujours étudiant)", requestBody: body(registerDto),
        responses: { "201": json("Compte créé", ref("User")), "409": err("`EMAIL_EXISTS`"), "422": err("`INVALID_DOMAIN`, `WEAK_PASSWORD` ou validation") },
      },
    },
    "/auth/verify-email": {
      post: { tags: ["Auth"], summary: "Vérifier l'e-mail (code à 6 chiffres)", requestBody: body(verifyEmailDto), responses: { "200": json("OK", ref("Ok")), "400": err("`INVALID_CODE`") } },
    },
    "/auth/resend-activation": {
      post: { tags: ["Auth"], summary: "Renvoyer le code (répond toujours OK)", requestBody: body(emailDto), responses: { "200": json("OK", ref("Ok")) } },
    },
    "/auth/forgot-password": {
      post: { tags: ["Auth"], summary: "Mot de passe oublié (répond toujours OK)", requestBody: body(emailDto), responses: { "200": json("OK", ref("Ok")) } },
    },
    "/auth/reset-password": {
      post: {
        tags: ["Auth"], summary: "Réinitialiser le mot de passe", requestBody: body(resetPasswordDto),
        responses: { "200": json("OK", ref("Ok")), "400": err("`INVALID_TOKEN`"), "422": err("`WEAK_PASSWORD`") },
      },
    },
    "/users": {
      post: {
        tags: ["Users"], summary: "Créer un compte (admin) — mot de passe temporaire envoyé par e-mail", security: secured, requestBody: body(adminCreateUserDto),
        responses: {
          "201": json("Compte créé", { type: "object", properties: { account: ref("User"), demoTemporaryPassword: { type: "string", description: "Seulement si EXPOSE_TEMP_PASSWORD=true (développement)" } } }),
          ...standardErrors, "409": err("`EMAIL_EXISTS`"), "422": err("`INVALID_DOMAIN` ou validation"),
        },
      },
      get: {
        tags: ["Users"], summary: "Lister les comptes (admin)", security: secured,
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Recherche nom, e-mail, matricule" },
          { name: "role", in: "query", schema: { type: "string", enum: ["student", "teacher", "admin"] } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "inactive", "suspended"] } },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 500 }, description: "Taille de page (500 maximum)" },
        ],
        responses: {
          "200": json("Comptes, statistiques globales et pagination", { type: "object", properties: { items: { type: "array", items: ref("User") }, stats: ref("UserStats"), page: { type: "integer" }, limit: { type: "integer" }, total: { type: "integer", description: "Comptes correspondant aux filtres" } } }),
          ...standardErrors,
        },
      },
    },
    "/users/{id}": {
      parameters: [idParam],
      get: { tags: ["Users"], summary: "Détail (soi-même ou admin)", security: secured, responses: { "200": json("Compte", ref("User")), ...standardErrors, "404": err("Introuvable") } },
      put: { tags: ["Users"], summary: "Modifier le profil (soi-même ou admin)", security: secured, requestBody: body(updateProfileDto), responses: { "200": json("Compte", ref("User")), ...standardErrors, "404": err("Introuvable") } },
      delete: { tags: ["Users"], summary: "Supprimer (admin, pas soi-même)", security: secured, responses: { "204": { description: "Supprimé" }, ...standardErrors, "409": err("`SELF_PROTECTED`"), "404": err("Introuvable") } },
    },
    "/users/{id}/password": {
      parameters: [idParam],
      put: {
        tags: ["Users"], summary: "Changer son mot de passe (soi-même)", security: secured, requestBody: body(changePasswordDto),
        responses: { "200": json("OK", ref("Ok")), "401": err("`WRONG_PASSWORD`"), "403": err("Pas le propriétaire"), "422": err("`SAME_PASSWORD` ou `WEAK_PASSWORD`") },
      },
    },
    "/users/{id}/avatar": {
      parameters: [idParam],
      put: { tags: ["Users"], summary: "Photo de profil (soi-même) — `null` pour supprimer", security: secured, requestBody: body(updateAvatarDto), responses: { "200": json("Compte", ref("User")), ...standardErrors } },
    },
    "/users/{id}/role": {
      parameters: [idParam],
      put: {
        tags: ["Users"], summary: "Changer le rôle (admin) — publie l'événement RôleModifié", security: secured, requestBody: body(changeRoleDto),
        responses: { "200": json("Compte", ref("User")), ...standardErrors, "409": err("`SELF_PROTECTED`"), "404": err("Introuvable") },
      },
    },
    "/users/{id}/status": {
      parameters: [idParam],
      patch: {
        tags: ["Users"], summary: "Activer / désactiver (admin) — activer remet les échecs à 0", security: secured, requestBody: body(changeStatusDto),
        responses: { "200": json("Compte", ref("User")), ...standardErrors, "409": err("`SELF_PROTECTED`"), "404": err("Introuvable") },
      },
    },
    "/users/{id}/login-history": {
      parameters: [idParam],
      get: { tags: ["History"], summary: "Historique d'un compte (soi-même ou admin)", security: secured, parameters: [resultQuery], responses: { "200": json("Événements", { type: "array", items: ref("LoginEvent") }), ...standardErrors } },
    },
    "/login-history": {
      get: { tags: ["History"], summary: "Historique global (admin)", security: secured, parameters: [resultQuery], responses: { "200": json("Événements", { type: "array", items: ref("LoginEvent") }), ...standardErrors } },
    },
    "/roles/permissions": {
      get: {
        tags: ["Roles"], summary: "Catalogue et matrice rôles × permissions (admin)", security: secured,
        responses: { "200": json("Catalogue et matrice", { type: "object", properties: { permissions: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, group: { type: "string" } } } }, matrix: { type: "object", additionalProperties: { type: "object", additionalProperties: { type: "boolean" } } } } }), ...standardErrors },
      },
      put: {
        tags: ["Roles"], summary: "Accorder / retirer une permission (admin)", security: secured, requestBody: body(setPermissionDto),
        responses: { "204": { description: "Appliqué" }, ...standardErrors, "422": err("`UNKNOWN_PERMISSION`") },
      },
    },
    "/health": { get: { tags: ["Ops"], summary: "Vivacité (+ base de données)", responses: { "200": { description: "UP" }, "503": { description: "DOWN" } } } },
    "/ready": { get: { tags: ["Ops"], summary: "Disponibilité détaillée (mongo, rabbitmq)", responses: { "200": { description: "UP ou DEGRADED" }, "503": { description: "DOWN" } } } },
  },
} as const;
