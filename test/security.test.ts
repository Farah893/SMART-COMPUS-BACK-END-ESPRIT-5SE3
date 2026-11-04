import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createJwtTokenService } from "../src/infrastructure/security/token-service.js";
import { toUpdate } from "../src/modules/users/repositories/user.repository.js";
import type { UserPatch } from "../src/modules/users/types/user.types.js";
import { createJwksRouter } from "../src/modules/auth/routes/jwks.routes.js";
import express from "express";
import { parse as parseYaml } from "yaml";
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

/* ------------------------- Politique des workflows (chaîne de livraison) ------------------------- */

const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");
const workflows = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"));

test("workflows GitHub : YAML valide (une erreur de syntaxe ne se découvre sinon qu'après le push)", () => {
  assert.ok(workflows.length >= 2, "ci.yml et codeql.yml attendus");
  for (const f of workflows) assert.doesNotThrow(() => parseYaml(readFileSync(join(WORKFLOW_DIR, f), "utf8")), f);
  assert.doesNotThrow(() => parseYaml(readFileSync("docker-compose.yml", "utf8")), "docker-compose.yml");
});

test("workflows GitHub : actions épinglées par SHA, lecture seule par défaut, durée maximale par travail", () => {
  for (const f of workflows) {
    const doc = parseYaml(readFileSync(join(WORKFLOW_DIR, f), "utf8")) as {
      permissions?: Record<string, string>;
      jobs: Record<string, { "timeout-minutes"?: number; steps: Array<{ uses?: string }> }>;
    };
    assert.deepEqual(doc.permissions, { contents: "read" }, `${f} : permissions par défaut = lecture seule`);
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job["timeout-minutes"], `${f}/${name} : timeout-minutes manquant`);
      for (const step of job.steps) {
        if (!step.uses) continue;
        assert.match(step.uses, /@[0-9a-f]{40}\b/, `${f}/${name} : « ${step.uses} » doit être épinglée par SHA de commit (pas par étiquette)`);
      }
    }
  }
});

test("Dockerfile : image de base épinglée par digest, scripts d'installation interdits, utilisateur non root, npm retiré de l'image finale", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const from = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
  assert.equal(from.length, 3);
  for (const l of from) assert.match(l, /@sha256:[0-9a-f]{64}/, `FROM sans digest : ${l}`);
  assert.equal(/npm ci(?![^\n]*--ignore-scripts)/.test(dockerfile), false, "npm ci sans --ignore-scripts");
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("AS runtime"));
  assert.match(runtime, /rm -rf \/usr\/local\/lib\/node_modules\/npm/, "npm doit être retiré de l'image finale");
  // `search` avec ^…$ cible l'INSTRUCTION `USER node`, pas le commentaire qui la mentionne.
  assert.ok(runtime.indexOf("rm -rf /usr/local/lib/node_modules/npm") < runtime.search(/^USER node$/m), "la suppression doit précéder USER node");
  assert.match(runtime, /^USER node$/m);
});

/* ----------- Alertes CodeQL : contournement par donnée utilisateur, course de fichiers, clé faible ----------- */

test("aucune décision de sécurité n'est prise d'après l'adresse demandée (originalUrl) dans le garde d'authentification", () => {
  const guard = readFileSync("src/modules/auth/middleware/auth.middleware.ts", "utf8");
  const code = guard.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
  assert.equal(/originalUrl|req\.url|req\.path|req\.method/.test(code), false, "le garde ne doit lire ni l'URL ni la méthode fournies par le client");
});

test("generate-keys : création exclusive (aucune course entre « existe-t-il ? » et « écrire »), refus d'écraser, --force explicite", () => {
  const dir = mkdtempSync(join(tmpdir(), "keys-"));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/scripts/generate-keys.ts", ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, KEYS_DIR: dir }, encoding: "utf8", cwd: process.cwd(),
    });
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const privateKey = readFileSync(join(dir, "jwt-private.pem"), "utf8");
    assert.match(privateKey, /BEGIN PRIVATE KEY/);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "jwt-private.pem")).mode & 0o777, 0o600, "droits 0600 dès la création");

    // Une clé existante n'est JAMAIS écrasée sans --force, et le refus est net (code 1, message explicite).
    writeFileSync(join(dir, "jwt-private.pem"), "CLE-EXISTANTE");
    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /existe déjà/);
    assert.equal(readFileSync(join(dir, "jwt-private.pem"), "utf8"), "CLE-EXISTANTE", "le fichier existant est intact");

    const forced = run("--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(join(dir, "jwt-private.pem"), "utf8"), /BEGIN PRIVATE KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
