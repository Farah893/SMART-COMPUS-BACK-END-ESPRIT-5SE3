import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.EXPOSE_TEMP_PASSWORD = "true";
process.env.SMTP_PORT = "1"; // aucun serveur SMTP : l'envoi échoue sans casser les requêtes

let mongod: MongoMemoryServer | undefined;
let server: Server | undefined;
let lifecycle: { draining: boolean } | undefined;
let base = "";

/* eslint-disable @typescript-eslint/no-explicit-any -- le corps JSON des réponses est volontairement non typé dans les tests */
interface CallOptions {
  token?: string;
  body?: unknown;
}
interface ApiResponse {
  status: number;
  body: any;
}

const call = async (method: string, path: string, { token, body }: CallOptions = {}): Promise<ApiResponse> => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const login = async (email: string, password: string) => call("POST", "/auth/login", { body: { email, password } });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { seed } = await import("../src/bootstrap/seed.js");
  const { createApp } = await import("../src/app.js");
  const { buildContainer } = await import("../src/container.js");
  const container = buildContainer();
  await seed(container);
  lifecycle = container.lifecycle;
  server = createApp(container).listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongod?.stop();
});

test("flux complet : admin crée un enseignant, mot de passe temporaire, changement obligatoire", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  assert.equal(admin.status, 200);
  const { sub, role } = JSON.parse(Buffer.from(admin.body.token.split(".")[1], "base64url").toString());
  assert.equal(role, "admin");
  assert.match(sub, /^ADM-\d{4}-0001$/);

  const created = await call("POST", "/users", {
    token: admin.body.token,
    body: { firstName: "Karim", lastName: "Trabelsi", email: "karim@smartcampus.tn", role: "teacher" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.mustChangePassword, true);
  assert.equal(created.body.account.passwordHash, undefined);
  const temp = created.body.demoTemporaryPassword;

  const dup = await call("POST", "/users", {
    token: admin.body.token,
    body: { firstName: "K", lastName: "T", email: "karim@smartcampus.tn", role: "teacher" },
  });
  assert.equal(dup.status, 409);

  const t = await login("karim@smartcampus.tn", temp);
  assert.equal(t.body.user.mustChangePassword, true);
  const id = t.body.user.id;

  const same = await call("PUT", `/users/${id}/password`, { token: t.body.token, body: { current: temp, next: temp } });
  assert.equal(same.body.code, "SAME_PASSWORD");
  const weak = await call("PUT", `/users/${id}/password`, { token: t.body.token, body: { current: temp, next: "abc" } });
  assert.equal(weak.body.code, "WEAK_PASSWORD");
  const wrong = await call("PUT", `/users/${id}/password`, { token: t.body.token, body: { current: "nope", next: "Nouveau2026" } });
  assert.equal(wrong.status, 401);
  const ok = await call("PUT", `/users/${id}/password`, { token: t.body.token, body: { current: temp, next: "Nouveau2026" } });
  assert.equal(ok.status, 200);
  assert.equal((await login("karim@smartcampus.tn", "Nouveau2026")).body.user.mustChangePassword, undefined);
});

test("droits : un enseignant ne liste pas les comptes ni ceux des autres", async () => {
  const t = await login("karim@smartcampus.tn", "Nouveau2026");
  assert.equal((await call("GET", "/users", { token: t.body.token })).status, 403);
  assert.equal((await call("GET", "/users/ADM-2026-0001", { token: t.body.token })).status, 403);
  assert.equal((await call("GET", `/users/${t.body.user.id}`, { token: t.body.token })).status, 200);
  assert.equal((await call("GET", "/users")).status, 401);
});

test("inscription publique : toujours étudiant, domaine imposé, e-mail unique", async () => {
  const body = { firstName: "Yasmine", lastName: "Ben Salah", email: "yasmine@smartcampus.tn", password: "Campus2026!", role: "admin" };
  const r = await call("POST", "/auth/register", { body });
  assert.equal(r.status, 201);
  assert.equal(r.body.role, "student");
  assert.equal((await call("POST", "/auth/register", { body })).status, 409);
  assert.equal((await call("POST", "/auth/register", { body: { ...body, email: "x@gmail.com" } })).status, 422);
});

test("inscription : connexion refusée tant que l'e-mail n'est pas vérifié ; le code est limité à 5 essais", async () => {
  const email = "yasmine@smartcampus.tn";
  const pending = await login(email, "Campus2026!");
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, "EMAIL_NOT_VERIFIED");

  const { Token } = await import("../src/modules/auth/models/verification-token.model.js");
  const { sha256 } = await import("../src/infrastructure/security/random.js");
  const plant = async () => {
    await Token.deleteMany({ email });
    await Token.create({ email, type: "verify-email", hash: sha256("123456"), expiresAt: new Date(Date.now() + 60_000) });
  };
  await plant();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/auth/verify-email", { body: { email, code: "000000" } })).status, 400);
  assert.equal((await call("POST", "/auth/verify-email", { body: { email, code: "123456" } })).status, 400, "code détruit après 5 essais");

  await plant();
  assert.equal((await call("POST", "/auth/verify-email", { body: { email, code: "123456" } })).status, 200);
  assert.equal((await login(email, "Campus2026!")).status, 200);
});

test("5 échecs : réponse 401 identique à un compte inconnu, verrouillage TEMPORAIRE, l'admin peut le lever", async () => {
  const unknown = await login("inconnu@smartcampus.tn", "mauvais");
  assert.equal(unknown.status, 401);
  let r!: ApiResponse;
  for (let i = 0; i < 5; i++) r = await login("yasmine@smartcampus.tn", "mauvais");
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, unknown.body, "aucune différence observable entre compte existant et inconnu");

  const locked = await login("yasmine@smartcampus.tn", "Campus2026!");
  assert.equal(locked.status, 423);
  assert.equal(locked.body.code, "ACCOUNT_LOCKED");
  assert.ok(new Date(locked.body.lockedUntil).getTime() > Date.now(), "date de fin de verrouillage communiquée au titulaire");

  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const list = await call("GET", "/users?status=suspended", { token: admin.body.token });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.stats.suspended, 1);
  assert.equal(list.body.items[0].avatarUrl, undefined, "les listes ne transportent pas les photos");
  const id = list.body.items[0].id;
  assert.equal((await call("PATCH", `/users/${id}/status`, { token: admin.body.token, body: { status: "active" } })).status, 200);
  assert.equal((await login("yasmine@smartcampus.tn", "Campus2026!")).status, 200);

  const hist = await call("GET", `/users/${id}/login-history?result=failure`, { token: admin.body.token });
  assert.equal(hist.body.length, 6);
  assert.equal((await call("PATCH", `/users/${id}/status`, { token: admin.body.token, body: { status: "inactive" } })).status, 200);
  assert.equal((await login("yasmine@smartcampus.tn", "mauvais")).status, 401, "compte désactivé + mauvais mot de passe : 401 générique");
  assert.equal((await login("yasmine@smartcampus.tn", "Campus2026!")).status, 403);
});

test("rôles : changement, auto-protection de l'admin, matrice verrouillée", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const self = admin.body.user.id;
  assert.equal((await call("PUT", `/users/${self}/role`, { token: admin.body.token, body: { role: "student" } })).status, 409);
  assert.equal((await call("DELETE", `/users/${self}`, { token: admin.body.token })).status, 409);

  const m = await call("GET", "/roles/permissions", { token: admin.body.token });
  assert.equal(m.body.permissions.length, 13);
  assert.equal(m.body.matrix.student["library.borrow"], true);
  assert.equal(m.body.matrix.admin["academic.manage"], true);
  assert.equal(m.body.matrix.teacher["academic.manage"], false);
  assert.equal((await call("PUT", "/roles/permissions", { token: admin.body.token, body: { role: "student", key: "clubs.manage", granted: true } })).status, 204);
  assert.equal((await call("GET", "/roles/permissions", { token: admin.body.token })).body.matrix.student["clubs.manage"], true);
  assert.equal((await call("PUT", "/roles/permissions", { token: admin.body.token, body: { role: "admin", key: "users.manage", granted: false } })).status, 403);
});

test("exploitation : /health, /ready (dépendances), identifiant de requête, OpenAPI et Swagger UI", async () => {
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { service: "user-service", status: "UP" });

  // RabbitMQ n'est pas configuré dans les tests : « disabled » ne dégrade pas le service.
  const ready = await call("GET", "/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { service: "user-service", status: "UP", checks: { mongo: "up", rabbitmq: "disabled" } });

  // L'identifiant du client est repris tel quel, sinon un UUID est généré ; il est toujours renvoyé en en-tête.
  const echoed = await fetch(`${base}/health`, { headers: { "x-request-id": "trace-123" } });
  assert.equal(echoed.headers.get("x-request-id"), "trace-123");
  assert.match((await fetch(`${base}/health`)).headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);

  const spec = await call("GET", "/openapi.json");
  assert.equal(spec.status, 200);
  assert.equal(spec.body.openapi, "3.0.3");
  for (const path of ["/auth/login", "/auth/refresh", "/auth/logout-all", "/users", "/users/{id}/role", "/roles/permissions", "/login-history", "/ready"]) {
    assert.ok(spec.body.paths[path], `chemin documenté : ${path}`);
  }
  // Les corps de requête documentés viennent des DTO zod (même source que la validation).
  const loginBody = spec.body.paths["/auth/login"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(loginBody.required.sort(), ["email", "password"]);

  const ui = await fetch(`${base}/docs/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /swagger-ui/);
});

test("contrat JSON : le compte exposé ne contient jamais de champ interne", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const me = await call("GET", `/users/${admin.body.user.id}`, { token: admin.body.token });
  assert.equal(me.status, 200);
  for (const hidden of ["_id", "__v", "passwordHash", "emailVerified", "updatedAt"]) {
    assert.equal(hidden in me.body, false, `${hidden} ne doit pas être exposé`);
  }
  assert.equal(me.body.id, admin.body.user.id);
  assert.match(me.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("versionnage : /v1 et l'alias historique donnent exactement les mêmes réponses", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const viaV1 = await call("POST", "/v1/auth/login", { body: { email: "admin@smartcampus.tn", password: "Admin2026!" } });
  assert.equal(viaV1.status, 200);
  assert.equal(viaV1.body.user.id, admin.body.user.id);

  const legacy = await call("GET", "/users", { token: admin.body.token });
  const v1 = await call("GET", "/v1/users", { token: admin.body.token });
  assert.equal(v1.status, 200);
  assert.deepEqual(v1.body, legacy.body);

  // Les sondes et la documentation ne sont pas versionnées.
  assert.equal((await call("GET", "/v1/health")).status, 404);
});

test("pagination : sans paramètre, comportement historique ; avec page/limit, pages stables et sans chevauchement", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const all = await call("GET", "/users", { token: admin.body.token });
  assert.equal(all.body.page, 1);
  assert.equal(all.body.limit, 500);
  assert.equal(all.body.total, all.body.items.length);
  assert.equal(all.body.stats.total >= all.body.total, true, "stats reste global");

  const p1 = await call("GET", "/users?limit=2&page=1", { token: admin.body.token });
  const p2 = await call("GET", "/users?limit=2&page=2", { token: admin.body.token });
  assert.equal(p1.body.items.length, 2);
  assert.equal(p1.body.total, all.body.total);
  const ids = [...p1.body.items, ...p2.body.items].map((u: { id: string }) => u.id);
  assert.equal(new Set(ids).size, ids.length, "aucun compte en double entre deux pages");
  assert.deepEqual(ids, all.body.items.slice(0, ids.length).map((u: { id: string }) => u.id), "même ordre que la liste complète");

  // Valeurs invalides ou excessives : ignorées / plafonnées, jamais d'erreur.
  const bad = await call("GET", "/users?page=zzz&limit=99999", { token: admin.body.token });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.limit, 500);
  assert.equal(bad.body.page, 1);
});

/** Crée un compte via l'admin et renvoie une session ouverte (mot de passe temporaire déjà remplacé). */
async function openSession(email: string) {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const created = await call("POST", "/users", {
    token: admin.body.token,
    body: { firstName: "Sess", lastName: "Ion", email, role: "teacher" },
  });
  assert.equal(created.status, 201);
  const first = await login(email, created.body.demoTemporaryPassword);
  const id = first.body.user.id;
  const changed = await call("PUT", `/users/${id}/password`, {
    token: first.body.token,
    body: { current: created.body.demoTemporaryPassword, next: "Nouveau2026!" },
  });
  assert.equal(changed.status, 200);
  return { id, email, password: "Nouveau2026!", first };
}

test("sessions : refresh à rotation, rejeu détecté, changement de mot de passe sans déconnexion brutale", async () => {
  const s = await openSession("sessions1@smartcampus.tn");

  // Le changement de mot de passe obligatoire ne coupe PAS le jeton d'accès courant (le front continue sa session)...
  assert.equal((await call("GET", `/users/${s.id}`, { token: s.first.body.token })).status, 200);
  // ... mais il met fin aux sessions longues ouvertes avant lui.
  assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: s.first.body.refreshToken } })).status, 401);

  const session = await login(s.email, s.password);
  assert.equal(typeof session.body.refreshToken, "string");

  const r1 = await call("POST", "/auth/refresh", { body: { refreshToken: session.body.refreshToken } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, session.body.refreshToken);
  assert.equal(r1.body.user.id, s.id);
  assert.equal((await call("GET", `/users/${s.id}`, { token: r1.body.token })).status, 200);

  // /v1 se comporte pareil.
  const r2 = await call("POST", "/v1/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
  assert.equal(r2.status, 200);

  // Rejeu de l'ancien jeton : 401 générique, et la famille entière est coupée.
  const replay = await call("POST", "/auth/refresh", { body: { refreshToken: session.body.refreshToken } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, "INVALID_REFRESH_TOKEN");
  assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: r2.body.refreshToken } })).status, 401);

  // Format invalide : validation, pas de requête en base.
  assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: "court" } })).status, 422);
});

test("déconnexion : logout termine la session ; logout-all invalide aussi les jetons d'accès déjà émis", async () => {
  const s = await openSession("sessions2@smartcampus.tn");

  const a = await login(s.email, s.password);
  assert.equal((await call("POST", "/auth/logout", { body: { refreshToken: a.body.refreshToken } })).status, 200);
  assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: a.body.refreshToken } })).status, 401);
  // logout est idempotent et ne révèle rien.
  assert.equal((await call("POST", "/auth/logout", { body: { refreshToken: "z".repeat(40) } })).status, 200);

  const old = await login(s.email, s.password);
  await new Promise((r) => setTimeout(r, 1100)); // le `iat` des JWT a une précision d'une seconde
  assert.equal((await call("POST", "/auth/logout-all", { token: old.body.token })).status, 200);

  const rejected = await call("GET", `/users/${s.id}`, { token: old.body.token });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.code, "SESSION_REVOKED");
  assert.equal((await call("POST", "/auth/refresh", { body: { refreshToken: old.body.refreshToken } })).status, 401);

  // Un jeton émis juste après (même seconde) est valide : pas de jeton « mort-né ».
  const fresh = await login(s.email, s.password);
  assert.equal((await call("GET", `/users/${s.id}`, { token: fresh.body.token })).status, 200);

  // logout-all exige d'être authentifié.
  assert.equal((await call("POST", "/auth/logout-all")).status, 401);
});

test("observabilité : /metrics expose des séries par GABARIT de route (jamais d'URL réelle) et compte les connexions", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  await call("GET", `/users/${admin.body.user.id}`, { token: admin.body.token });
  await call("GET", `/v1/users/${admin.body.user.id}`, { token: admin.body.token });
  await call("GET", "/cette-route-nexiste-pas");
  await login("admin@smartcampus.tn", "Admin2026!");

  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  const text = await res.text();

  assert.match(text, /http_request_duration_seconds_bucket\{[^}]*method="GET"[^}]*route="\/users\/:id"[^}]*status_code="200"/);
  assert.equal(text.includes(admin.body.user.id), false, "le matricule ne doit jamais devenir une étiquette (cardinalité)");
  assert.equal(/route="\/v1\//.test(text), false, "/v1 et l'alias partagent les mêmes séries");
  assert.match(text, /route="unmatched"[^}]*status_code="404"/);
  assert.match(text, /auth_login_attempts_total\{[^}]*result="success"[^}]*\} [1-9]/);
  assert.match(text, /process_cpu_user_seconds_total/);
  assert.match(text, /outbox_pending_events/);
});

test("arrêt progressif : /ready passe à 503 DRAINING, /health reste à 200", async () => {
  lifecycle!.draining = true;
  try {
    const ready = await call("GET", "/ready");
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, "DRAINING");
    assert.equal((await call("GET", "/health")).status, 200);
  } finally {
    lifecycle!.draining = false;
  }
  assert.equal((await call("GET", "/ready")).status, 200);
});

/* ------------------------- Session par cookies httpOnly ------------------------- */

/** Client minimal avec « pot de cookies » : fetch Node n'en a pas. */
const cookieCall = async (method: string, path: string, jar: Map<string, string>, headers: Record<string, string> = {}, body?: unknown) => {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie && { Cookie: cookie }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = res.headers.getSetCookie();
  for (const raw of setCookies) {
    const [pair = ""] = raw.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (value === "" || /expires=thu, 01 jan 1970/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookies };
};
const COOKIE_MODE = { "X-Auth-Mode": "cookie" };

test("cookies : la connexion pose deux cookies httpOnly et ne renvoie aucun jeton dans le corps", async () => {
  const jar = new Map<string, string>();
  const res = await cookieCall("POST", "/auth/login", jar, COOKIE_MODE, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined);
  assert.equal(res.body.refreshToken, undefined);
  assert.equal(res.body.user.role, "admin");
  assert.equal(res.setCookies.length, 2);
  for (const c of res.setCookies) {
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Strict/i);
    assert.match(c, /Path=\//i);
  }
  assert.ok(jar.has("sc_access") && jar.has("sc_refresh"));
});

test("cookies : sans l'en-tête X-Auth-Mode, le comportement historique est inchangé (jetons dans le corps, aucun cookie)", async () => {
  const jar = new Map<string, string>();
  const res = await cookieCall("POST", "/auth/login", jar, {}, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  assert.equal(typeof res.body.token, "string");
  assert.equal(typeof res.body.refreshToken, "string");
  assert.equal(res.setCookies.length, 0);
});

test("cookies : l'authentification par cookie fonctionne, et l'en-tête Bearer reste prioritaire", async () => {
  const jar = new Map<string, string>();
  await cookieCall("POST", "/auth/login", jar, COOKIE_MODE, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  assert.equal((await cookieCall("GET", "/users", jar)).status, 200);
  assert.equal((await cookieCall("GET", "/users", new Map())).status, 401);
  const bearer = await login("admin@smartcampus.tn", "Admin2026!");
  assert.equal((await cookieCall("GET", "/users", new Map([["sc_access", "poubelle"]]), { Authorization: `Bearer ${bearer.body.token}` })).status, 200);
});

test("cookies : CSRF — une requête qui modifie des données par cookie exige l'en-tête et une origine autorisée", async () => {
  const jar = new Map<string, string>();
  await cookieCall("POST", "/auth/login", jar, COOKIE_MODE, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  // Sans l'en-tête personnalisé (ce que ferait un formulaire d'un site tiers) : refus, et la session n'est pas touchée.
  const noHeader = await cookieCall("POST", "/auth/logout-all", jar);
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.body.code, "CSRF_REJECTED");
  // En-tête présent mais origine inconnue : refus.
  assert.equal((await cookieCall("POST", "/auth/logout-all", jar, { ...COOKIE_MODE, Origin: "https://evil.example" })).status, 403);
  assert.equal((await cookieCall("POST", "/auth/refresh", jar, { Origin: "https://evil.example" }, {})).status, 403);
  // Les lectures (GET) ne sont pas concernées, et l'authentification reste valable.
  assert.equal((await cookieCall("GET", "/users", jar)).status, 200);
  // Un client Bearer n'est pas soumis à cette règle (pas de cookie ambiant, donc pas de CSRF).
  const bearer = await login("admin@smartcampus.tn", "Admin2026!");
  assert.equal((await call("POST", "/auth/logout-all", { token: bearer.body.token })).status, 200);
});

test("cookies : refresh avec rotation, rejeu détecté et cookies effacés, déconnexion qui retire les cookies", async () => {
  const jar = new Map<string, string>();
  await cookieCall("POST", "/auth/login", jar, COOKIE_MODE, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  const firstRefresh = jar.get("sc_refresh")!;

  const r1 = await cookieCall("POST", "/auth/refresh", jar, COOKIE_MODE, {});
  assert.equal(r1.status, 200);
  assert.equal(r1.body.token, undefined);
  assert.notEqual(jar.get("sc_refresh"), firstRefresh, "le jeton de rafraîchissement tourne");
  assert.equal((await cookieCall("GET", "/users", jar)).status, 200);

  // Rejeu de l'ancien jeton (volé) : 401, la famille entière est révoquée et les cookies sont effacés.
  const replay = await cookieCall("POST", "/auth/refresh", new Map([["sc_refresh", firstRefresh]]), COOKIE_MODE, {});
  assert.equal(replay.status, 401);
  assert.ok(replay.setCookies.some((c) => /sc_refresh=;/.test(c)), "cookies effacés sur session morte");
  assert.equal((await cookieCall("POST", "/auth/refresh", jar, COOKIE_MODE, {})).status, 401);

  // Pas de cookie du tout : 401 propre (et non 400).
  assert.equal((await cookieCall("POST", "/auth/refresh", new Map(), COOKIE_MODE, {})).status, 401);

  const fresh = new Map<string, string>();
  await cookieCall("POST", "/auth/login", fresh, COOKIE_MODE, { email: "admin@smartcampus.tn", password: "Admin2026!" });
  const out = await cookieCall("POST", "/auth/logout", fresh, COOKIE_MODE, {});
  assert.equal(out.status, 200);
  assert.equal(fresh.size, 0, "les deux cookies sont retirés");
  assert.equal((await cookieCall("POST", "/auth/refresh", new Map([["sc_refresh", "x".repeat(40)]]), COOKIE_MODE, {})).status, 401);
});

/* ------------------------------ Durcissement (audit de sécurité) ------------------------------ */

test("mot de passe temporaire : le serveur n'autorise que le changement de mot de passe, le profil et la déconnexion", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const created = await call("POST", "/users", {
    token: admin.body.token,
    body: { firstName: "Second", lastName: "Admin", email: "admin2@smartcampus.tn", role: "admin" },
  });
  const temp = created.body.demoTemporaryPassword;
  const s = await login("admin2@smartcampus.tn", temp);
  const id = s.body.user.id;

  for (const [method, path] of [["GET", "/users"], ["GET", "/roles/permissions"], ["POST", "/users"], ["GET", "/v1/users"], ["GET", `/users/${admin.body.user.id}`]] as const) {
    const r = await call(method, path, { token: s.body.token, body: method === "POST" ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${path}`);
    if (path !== `/users/${admin.body.user.id}`) assert.equal(r.body.code, "PASSWORD_CHANGE_REQUIRED", `${method} ${path}`);
  }
  assert.equal((await call("GET", `/users/${id}`, { token: s.body.token })).status, 200, "son propre profil reste lisible");
  assert.equal((await call("PUT", `/users/${id}/password`, { token: s.body.token, body: { current: temp, next: "Nouveau2026" } })).status, 200);
  assert.equal((await call("GET", "/users", { token: s.body.token })).status, 200, "après le changement, l'accès est complet");
});

test("photo de profil : image `data:` vérifiée uniquement (pas d'URL externe, pas de faux contenu, taille limitée)", async () => {
  const t = await login("karim@smartcampus.tn", "Nouveau2026");
  const id = t.body.user.id;
  const put = (avatarUrl: string | null) => call("PUT", `/users/${id}/avatar`, { token: t.body.token, body: { avatarUrl } });
  const png = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  assert.equal((await put("https://tracker.example/pixel.png")).status, 422, "URL externe refusée (pixel espion)");
  assert.equal((await put("data:image/png;base64," + Buffer.from("<script>alert(1)</script>").toString("base64"))).status, 422, "contenu qui n'est pas une image");
  assert.equal((await put("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).status, 422, "SVG refusé (peut contenir du script)");
  assert.equal((await put(png + "A".repeat(150_000))).status, 422, "trop lourde");
  assert.equal((await put(png)).status, 200);
  assert.equal((await call("GET", `/users/${id}`, { token: t.body.token })).body.avatarUrl, png);
  assert.equal((await put(null)).status, 200);
});

test("mot de passe : plus de 72 octets refusé (bcrypt tronquerait en silence)", async () => {
  const r = await call("POST", "/auth/register", {
    body: { firstName: "Long", lastName: "Pass", email: "long@smartcampus.tn", password: "Aa1" + "x".repeat(80) },
  });
  assert.equal(r.status, 422);
});

test("identifiant de requête : une valeur sobre du client est conservée, une valeur louche est remplacée", async () => {
  const echo = async (id: string) => (await fetch(`${base}/health`, { headers: { "x-request-id": id } })).headers.get("x-request-id");
  assert.equal(await echo("trace-abc-12345"), "trace-abc-12345");
  const replaced = await echo("x");
  assert.notEqual(replaced, "x");
  assert.match(replaced ?? "", /^[0-9a-f-]{36}$/);
});
