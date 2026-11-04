import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionService } from "../src/modules/auth/services/session.service.js";
import { sha256 } from "../src/infrastructure/security/random.js";
import { InMemoryRefreshTokenRepository } from "./helpers/fakes.js";

/** Sessions longues : rotation à chaque usage, détection de rejeu, expiration, révocation. */

const setup = (graceSeconds = 0) => {
  const repo = new InMemoryRefreshTokenRepository();
  return { repo, sessions: new SessionService(repo, { ttlDays: 30, graceSeconds }) };
};

test("le jeton est stocké haché, jamais en clair", async () => {
  const { repo, sessions } = setup();
  const token = await sessions.open("ETU-2026-0001");
  assert.equal(repo.rows.some((r) => r.hash === token), false);
  assert.equal(repo.rows[0]!.hash, sha256(token));
});

test("rotation : chaque usage donne un nouveau jeton de la même famille et consomme l'ancien", async () => {
  const { repo, sessions } = setup();
  const first = await sessions.open("ETU-2026-0001");
  const second = await sessions.rotate(first);
  assert.notEqual(second.refreshToken, first);
  assert.equal(second.userId, "ETU-2026-0001");
  assert.equal(new Set(repo.rows.map((r) => r.familyId)).size, 1, "une seule famille");
  const third = await sessions.rotate(second.refreshToken);
  assert.equal(third.userId, "ETU-2026-0001");
});

test("rejeu d'un jeton déjà consommé : 401 ET toute la famille est révoquée (même le jeton le plus récent)", async () => {
  const { sessions } = setup();
  const first = await sessions.open("ETU-2026-0001");
  const second = await sessions.rotate(first);

  await assert.rejects(sessions.rotate(first), { kind: "unauthorized", details: { code: "INVALID_REFRESH_TOKEN" } });
  // Le voleur ou le client légitime : dans le doute, la session entière est coupée.
  await assert.rejects(sessions.rotate(second.refreshToken), { kind: "unauthorized" });
});

test("deux échanges simultanés du même jeton : un seul réussit", async () => {
  const { sessions } = setup();
  const token = await sessions.open("ETU-2026-0001");
  const results = await Promise.allSettled([sessions.rotate(token), sessions.rotate(token)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("jeton inconnu, expiré ou révoqué : même réponse générique", async () => {
  const { repo, sessions } = setup();
  await assert.rejects(sessions.rotate("x".repeat(40)), { details: { code: "INVALID_REFRESH_TOKEN" } });

  const expired = await sessions.open("ETU-2026-0001");
  repo.rows.find((r) => r.hash === sha256(expired))!.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(sessions.rotate(expired), { details: { code: "INVALID_REFRESH_TOKEN" } });

  const revoked = await sessions.open("ETU-2026-0001");
  await sessions.close(revoked);
  await assert.rejects(sessions.rotate(revoked), { details: { code: "INVALID_REFRESH_TOKEN" } });
});

test("closeAll termine toutes les sessions du compte, pas celles des autres", async () => {
  const { sessions } = setup();
  const mine1 = await sessions.open("ETU-2026-0001");
  const mine2 = await sessions.open("ETU-2026-0001");
  const other = await sessions.open("ETU-2026-0002");
  await sessions.closeAll("ETU-2026-0001");
  await assert.rejects(sessions.rotate(mine1));
  await assert.rejects(sessions.rotate(mine2));
  assert.equal((await sessions.rotate(other)).userId, "ETU-2026-0002");
});

test("fenêtre de grâce : deux onglets qui présentent le même jeton à la suite ne sont pas pris pour un vol", async () => {
  const { repo, sessions } = setup(10);
  const first = await sessions.open("ETU-2026-0001");
  const tabA = await sessions.rotate(first);
  const tabB = await sessions.rotate(first); // même jeton, quelques ms après : requête simultanée
  assert.notEqual(tabA.refreshToken, tabB.refreshToken);
  assert.equal(new Set(repo.rows.map((r) => r.familyId)).size, 1, "toujours la même famille");
  assert.equal((await sessions.rotate(tabB.refreshToken)).userId, "ETU-2026-0001", "la session continue");
});

test("fenêtre de grâce dépassée : le rejeu redevient un vol (famille révoquée)", async () => {
  const { repo, sessions } = setup(10);
  const first = await sessions.open("ETU-2026-0001");
  const second = await sessions.rotate(first);
  repo.rows.find((r) => r.hash === sha256(first))!.usedAt = new Date(Date.now() - 11_000); // consommé il y a 11 s
  await assert.rejects(sessions.rotate(first), { kind: "unauthorized" });
  await assert.rejects(sessions.rotate(second.refreshToken), { kind: "unauthorized" }, "toute la famille est coupée");
});

test("fenêtre de grâce : un jeton révoqué (déconnexion) n'est jamais ressuscité", async () => {
  const { sessions } = setup(10);
  const first = await sessions.open("ETU-2026-0001");
  await sessions.rotate(first);
  await sessions.close(first);
  await assert.rejects(sessions.rotate(first), { kind: "unauthorized" });
});
