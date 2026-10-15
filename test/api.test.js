import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.EXPOSE_TEMP_PASSWORD = "true";
process.env.SMTP_PORT = "1"; // aucun serveur SMTP : l'envoi échoue sans casser les requêtes

let mongod, server, base;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const login = async (email, password) => call("POST", "/auth/login", { body: { email, password } });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const { seed } = await import("../src/seed.js");
  const { createApp } = await import("../src/app.js");
  await seed();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongod?.stop();
});

test("flux complet : admin crée un enseignant, mot de passe temporaire, changement obligatoire", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  assert.equal(admin.status, 200);
  const { sub, role } = JSON.parse(Buffer.from(admin.body.token.split(".")[1], "base64url"));
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

test("5 échecs consécutifs suspendent le compte (423), l'admin le réactive", async () => {
  let r;
  for (let i = 0; i < 5; i++) r = await login("yasmine@smartcampus.tn", "mauvais");
  assert.equal(r.status, 423);
  assert.equal((await login("yasmine@smartcampus.tn", "Campus2026!")).status, 423);

  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const list = await call("GET", "/users?status=suspended", { token: admin.body.token });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.stats.suspended, 1);
  const id = list.body.items[0].id;
  assert.equal((await call("PATCH", `/users/${id}/status`, { token: admin.body.token, body: { status: "active" } })).status, 200);
  assert.equal((await login("yasmine@smartcampus.tn", "Campus2026!")).status, 200);

  const hist = await call("GET", `/users/${id}/login-history?result=failure`, { token: admin.body.token });
  assert.equal(hist.body.length, 6);
  assert.equal((await call("PATCH", `/users/${id}/status`, { token: admin.body.token, body: { status: "inactive" } })).status, 200);
  assert.equal((await login("yasmine@smartcampus.tn", "Campus2026!")).status, 403);
});

test("rôles : changement, auto-protection de l'admin, matrice verrouillée", async () => {
  const admin = await login("admin@smartcampus.tn", "Admin2026!");
  const self = admin.body.user.id;
  assert.equal((await call("PUT", `/users/${self}/role`, { token: admin.body.token, body: { role: "student" } })).status, 409);
  assert.equal((await call("DELETE", `/users/${self}`, { token: admin.body.token })).status, 409);

  const m = await call("GET", "/roles/permissions", { token: admin.body.token });
  assert.equal(m.body.permissions.length, 12);
  assert.equal(m.body.matrix.student["library.borrow"], true);
  assert.equal((await call("PUT", "/roles/permissions", { token: admin.body.token, body: { role: "student", key: "clubs.manage", granted: true } })).status, 204);
  assert.equal((await call("GET", "/roles/permissions", { token: admin.body.token })).body.matrix.student["clubs.manage"], true);
  assert.equal((await call("PUT", "/roles/permissions", { token: admin.body.token, body: { role: "admin", key: "users.manage", granted: false } })).status, 403);
});
