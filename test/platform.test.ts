import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { AppError } from "../src/shared/errors/app-error.js";
import { STATUS_BY_KIND, errorHandler } from "../src/shared/middleware/error-handler.js";
import { adminCreateUserDto, listUsersQueryDto } from "../src/modules/users/dto/user.dto.js";
import { registerDto } from "../src/modules/auth/dto/auth.dto.js";
import { escapeRegExp, isInstitutionalEmail, isStrongPassword } from "../src/shared/validation/policies.js";


/** Gestionnaire d'erreurs : la nature de l'erreur est traduite en statut HTTP à un seul endroit. */
function run(err: unknown) {
  let status = 0;
  let body: unknown;
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response;
  errorHandler(err, { id: "req-1" } as unknown as Request, res, () => {});
  return { status, body };
}

test("AppError → statut HTTP via le tableau unique, détails conservés dans le corps", () => {
  assert.deepEqual(STATUS_BY_KIND, {
    bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, unprocessable: 422, locked: 423,
  });
  const { status, body } = run(new AppError("locked", "Compte suspendu", { code: "ACCOUNT_LOCKED", failedAttempts: 5 }));
  assert.equal(status, 423);
  assert.deepEqual(body, { message: "Compte suspendu", code: "ACCOUNT_LOCKED", failedAttempts: 5 });
});

test("erreurs techniques : JSON invalide 400, trop gros 413, doublon Mongo 409, inconnu 500 sans fuite", () => {
  assert.equal(run({ type: "entity.parse.failed" }).status, 400);
  assert.equal(run({ type: "entity.too.large" }).status, 413);
  assert.equal(run({ code: 11000 }).status, 409);
  const unknown = run(new Error("secret interne : mot de passe de la base"));
  assert.equal(unknown.status, 500);
  assert.deepEqual(unknown.body, { message: "Erreur interne du serveur" });
});

test("DTO d'inscription : le rôle envoyé par le client est supprimé, l'e-mail normalisé", () => {
  const dto = registerDto.parse({ firstName: " Ali ", lastName: "B", email: " ALI@Gmail.com ", password: "Passw0rdOK", role: "admin" });
  assert.equal("role" in dto, false);
  assert.equal(dto.email, "ali@gmail.com");
  assert.equal(dto.firstName, "Ali");
});

test("DTO de création : rôle limité à la liste ; filtres de liste invalides ignorés au lieu d'échouer", () => {
  assert.equal(adminCreateUserDto.safeParse({ firstName: "A", lastName: "B", email: "a@b.tn", role: "root" }).success, false);
  assert.deepEqual(listUsersQueryDto.parse({ role: "root", status: "zzz", q: ["a", "b"] }), { q: undefined, role: undefined, status: undefined });
});

test("politiques : domaine institutionnel, mot de passe fort, échappement des regex de recherche", () => {
  assert.equal(isInstitutionalEmail("a@gmail.com"), true);
  assert.equal(isInstitutionalEmail("a@gmail.com.evil.com"), false);
  assert.equal(isInstitutionalEmail("a@example.com"), false);
  assert.equal(isStrongPassword("Abcdefg1"), true);
  assert.equal(isStrongPassword("abcdefg1"), false);
  assert.equal(escapeRegExp("a.*b(c)"), "a\\.\\*b\\(c\\)");
});

/** Protection de /metrics : jeton exigé s'il est défini, route absente en production sans jeton. */
async function metricsStatus(opts: { token?: string; isProd: boolean }, authorization?: string) {
  const { default: express } = await import("express");
  const { createMetricsRouter } = await import("../src/modules/health/routes/metrics.routes.js");
  const app = express().use(createMetricsRouter(opts));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://localhost:${port}/metrics`, { headers: authorization ? { authorization } : {} });
    return res.status;
  } finally {
    server.close();
  }
}

test("/metrics : 404 en production sans jeton ; avec jeton, 401 sans lui et 200 avec ; libre en développement", async () => {
  assert.equal(await metricsStatus({ isProd: true }), 404);
  assert.equal(await metricsStatus({ isProd: true, token: "un-jeton-secret" }), 401);
  assert.equal(await metricsStatus({ isProd: true, token: "un-jeton-secret" }, "Bearer mauvais-jeton-xx"), 401);
  assert.equal(await metricsStatus({ isProd: true, token: "un-jeton-secret" }, "Bearer un-jeton-secret"), 200);
  assert.equal(await metricsStatus({ isProd: false }), 200);
});

test("étiquette de route : gabarit normalisé, /v1 fusionné avec l'alias, inconnu = unmatched", async () => {
  const { routeLabel } = await import("../src/infrastructure/observability/http-metrics.js");
  assert.equal(routeLabel("/users", "/:id"), "/users/:id");
  assert.equal(routeLabel("/v1/users", "/:id"), "/users/:id");
  assert.equal(routeLabel("/v1/users", "/"), "/users");
  assert.equal(routeLabel("", "/health"), "/health");
  assert.equal(routeLabel("", undefined), "unmatched");
});
