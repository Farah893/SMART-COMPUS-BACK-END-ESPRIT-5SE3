import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createJwtTokenService } from "../src/infrastructure/security/token-service.js";
import { toUpdate } from "../src/modules/users/repositories/user.repository.js";
import type { UserPatch } from "../src/modules/users/types/user.types.js";
import { createJwksRouter } from "../src/modules/auth/routes/jwks.routes.js";
import express from "express";
import { createRateLimiters } from "../src/shared/http/rate-limiters.js";

/** Petit serveur de test branché sur les VRAIS limiteurs de l'application (en test, l'application les désactive). */
async function withLimiters(options: Parameters<typeof createRateLimiters>[0], run: (url: string) => Promise<void>) {
  const limit = createRateLimiters(options);
  const app = express();
  app.use(express.json());
  app.post("/login", limit.loginIp, limit.login, (req, res) => {
    const { password } = req.body as { password?: string };
    res.status(password === "bon" ? 200 : 401).json({});
  });
  app.post("/forgot", limit.sensitiveIp, limit.sensitive, (_req, res) => void res.json({ ok: true }));
  const server = app.listen(0);
  try {
    await run(`http://localhost:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);

test("limiteur de connexion : par compte, seuls les échecs comptent, un autre compte n'est pas pénalisé", async () => {
  await withLimiters({ enabled: true, login: 3 }, async (url) => {
    for (let i = 0; i < 3; i++) assert.equal(await post(`${url}/login`, { email: "a@x.tn", password: "faux" }), 401);
    assert.equal(await post(`${url}/login`, { email: "a@x.tn", password: "faux" }), 429, "4e échec sur le même compte : bloqué");
    assert.equal(await post(`${url}/login`, { email: "a@x.tn", password: "bon" }), 429, "même le bon mot de passe est freiné pendant la fenêtre");
    assert.equal(await post(`${url}/login`, { email: "b@x.tn", password: "faux" }), 401, "autre compte, même IP : non concerné");
  });
});

test("limiteur de connexion : les connexions réussies ne consomment pas le quota (campus derrière une même IP)", async () => {
  await withLimiters({ enabled: true, login: 2 }, async (url) => {
    for (let i = 0; i < 10; i++) assert.equal(await post(`${url}/login`, { email: "a@x.tn", password: "bon" }), 200);
  });
});

test("envois sensibles : quota strict par destinataire (anti-inondation d'e-mails)", async () => {
  await withLimiters({ enabled: true, sensitive: 2 }, async (url) => {
    assert.equal(await post(`${url}/forgot`, { email: "v@x.tn" }), 200);
    assert.equal(await post(`${url}/forgot`, { email: "v@x.tn" }), 200);
    assert.equal(await post(`${url}/forgot`, { email: "v@x.tn" }), 429);
    assert.equal(await post(`${url}/forgot`, { email: "autre@x.tn" }), 200);
  });
});

/* ------------------------------ RS256 / JWKS ------------------------------ */

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const user = { _id: "ADM-2026-0001", firstName: "Ada", lastName: "Min", role: "admin" };
const OPTS = { expiresIn: "15m", issuer: "smartcampus-user-service", audience: "smartcampus" };

test("RS256 : signature avec la clé privée, vérification avec la clé publique, claims et en-tête kid", () => {
  const { privateKey } = rsa();
  const svc = createJwtTokenService({ ...OPTS, privateKeyPem: privateKey });
  const token = svc.sign(user);
  const decoded = jwt.decode(token, { complete: true })!;
  assert.equal(decoded.header.alg, "RS256");
  assert.ok(decoded.header.kid);
  const claims = svc.verify(token);
  assert.deepEqual([claims.sub, claims.role], ["ADM-2026-0001", "admin"]);
  assert.deepEqual(
    [(decoded.payload as jwt.JwtPayload).iss, (decoded.payload as jwt.JwtPayload).aud],
    ["smartcampus-user-service", "smartcampus"],
  );
});

test("RS256 : attaque par confusion d'algorithme (HS256 signé avec la clé PUBLIQUE) et alg:none refusés", () => {
  const { privateKey, publicKey } = rsa();
  const svc = createJwtTokenService({ ...OPTS, privateKeyPem: privateKey });
  const kid = jwt.decode(svc.sign(user), { complete: true })!.header.kid;
  const forged = jwt.sign({ sub: "ADM-2026-0001", name: "x", role: "admin" }, publicKey, { algorithm: "HS256", keyid: kid, issuer: OPTS.issuer, audience: OPTS.audience });
  assert.throws(() => svc.verify(forged), /invalid algorithm|signature/i);
  const none = [Buffer.from(JSON.stringify({ alg: "none", kid })).toString("base64url"), Buffer.from(JSON.stringify({ sub: "ADM-2026-0001", role: "admin" })).toString("base64url"), ""].join(".");
  assert.throws(() => svc.verify(none));
});

test("RS256 : jeton d'un autre émetteur, d'une autre audience, d'une autre clé ou expiré refusé", () => {
  const a = rsa();
  const b = rsa();
  const svc = createJwtTokenService({ ...OPTS, privateKeyPem: a.privateKey });
  assert.throws(() => svc.verify(createJwtTokenService({ ...OPTS, issuer: "autre", privateKeyPem: a.privateKey }).sign(user)), /issuer/);
  assert.throws(() => svc.verify(createJwtTokenService({ ...OPTS, audience: "autre", privateKeyPem: a.privateKey }).sign(user)), /audience/);
  assert.throws(() => svc.verify(createJwtTokenService({ ...OPTS, privateKeyPem: b.privateKey }).sign(user)), /inconnue|signature/);
  assert.throws(() => svc.verify(createJwtTokenService({ ...OPTS, expiresIn: "-10s", privateKeyPem: a.privateKey }).sign(user)), /expired/);
});

test("rotation de clé : l'ancienne clé publique reste acceptée, les deux sont publiées en JWKS, la privée jamais", () => {
  const oldKeys = rsa();
  const newKeys = rsa();
  const oldToken = createJwtTokenService({ ...OPTS, privateKeyPem: oldKeys.privateKey }).sign(user);
  const svc = createJwtTokenService({ ...OPTS, privateKeyPem: newKeys.privateKey, previousPublicKeyPem: oldKeys.publicKey });
  assert.equal(svc.verify(oldToken).sub, "ADM-2026-0001");
  const { keys } = svc.jwks();
  assert.equal(keys.length, 2);
  for (const k of keys) {
    assert.equal(k.kty, "RSA");
    assert.equal(k.alg, "RS256");
    assert.ok(k.n && k.e && k.kid);
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) assert.equal(k[secret], undefined, `paramètre privé « ${secret} » publié !`);
  }
});

test("clés trop faibles ou HS256 sans secret : refusés au démarrage du service de jetons", () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  assert.throws(() => createJwtTokenService({ ...OPTS, privateKeyPem: weak.privateKey }), /2048/);
  assert.throws(() => createJwtTokenService({ ...OPTS }), /JWT_PRIVATE_KEY/);
  assert.deepEqual(createJwtTokenService({ ...OPTS, secret: "dev" }).jwks(), { keys: [] }, "un secret partagé ne se publie jamais");
});

test("GET /.well-known/jwks.json : public, mis en cache, clés publiques seulement", async () => {
  const { privateKey } = rsa();
  const app = express().use(createJwksRouter({ tokenService: createJwtTokenService({ ...OPTS, privateKeyPem: privateKey }) }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/.well-known/jwks.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /max-age=300/);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0]!.d, undefined);
  } finally {
    server.close();
  }
});

/** La configuration est lue une seule fois à l'import : on la teste dans un processus fils. */
function bootInProduction(env: Record<string, string>) {
  const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production", ...env };
  return spawnSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/config/index.ts").then(()=>console.log("DEMARRE"))'], {
    env: clean, encoding: "utf8", cwd: process.cwd(),
  });
}
const GOOD = { JWT_PRIVATE_KEY: Buffer.from(rsa().privateKey).toString("base64"), FIRST_ADMIN_PASSWORD: "Bon-Motdepasse-2026" };

test("production : refuse de démarrer avec les valeurs par défaut ou d'exemple", () => {
  const defaults = bootInProduction({});
  assert.notEqual(defaults.status, 0);
  assert.match(defaults.stderr, /JWT_PRIVATE_KEY/);
  assert.match(defaults.stderr, /FIRST_ADMIN_PASSWORD/);

  // Un secret partagé (même long et aléatoire) n'est plus admis en production : RS256 obligatoire.
  const { JWT_PRIVATE_KEY: _key, ...withoutKey } = GOOD;
  assert.match(bootInProduction({ ...withoutKey, JWT_SECRET: "x".repeat(8) + "Qm7!pLz2#vR9$wK4&nB6@tY1^cD3*eF5" }).stderr, /JWT_PRIVATE_KEY/);
  assert.match(bootInProduction({ ...GOOD, FIRST_ADMIN_PASSWORD: "Admin2026!" }).stderr, /FIRST_ADMIN_PASSWORD/);
  assert.match(bootInProduction({ ...GOOD, EXPOSE_TEMP_PASSWORD: "true" }).stderr, /EXPOSE_TEMP_PASSWORD/);
  assert.match(bootInProduction({ ...GOOD, COOKIE_SECURE: "false" }).stderr, /COOKIE_SECURE/);
});

test("production : démarre avec une configuration solide (RS256, cookies Secure, documentation désactivée par défaut)", () => {
  const ok = bootInProduction(GOOD);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /DEMARRE/);
});

test("mises à jour de compte : seules les clés autorisées atteignent MongoDB (liste blanche)", () => {
  // JSON.parse crée VRAIMENT une clé « __proto__ » (un littéral d'objet ne le ferait pas) : c'est le cas d'une charge hostile.
  const hostile = JSON.parse('{"firstName":"Ada","role":"student","$where":"sleep(5000)","isAdmin":true,"__proto__":{"polluted":1},"phone":"123"}') as UserPatch;
  const update = toUpdate(hostile) as { $set: Record<string, unknown> };
  assert.deepEqual(Object.keys(update.$set).sort(), ["firstName", "phone", "role"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "aucune pollution de prototype");
  assert.deepEqual(toUpdate({ phone: undefined }), { $unset: { phone: "" } }, "undefined supprime toujours le champ");
});
