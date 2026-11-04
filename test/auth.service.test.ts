import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/infrastructure/security/random.js";
import { AuthService } from "../src/modules/auth/services/auth.service.js";
import type { LoginHistoryService } from "../src/modules/login-history/services/login-history.service.js";
import { UserService } from "../src/modules/users/services/user.service.js";
import { SessionService } from "../src/modules/auth/services/session.service.js";
import { InMemoryRefreshTokenRepository, InMemoryTokenRepository, InMemoryUserRepository, fakeHasher, fakeTokens, makeUser, noSessions, recordingBus, silentMailer } from "./helpers/fakes.js";

const context = { ip: "127.0.0.1", userAgent: "test" };

function setup(maxAttempts = 3, over: { cooldown?: number } = {}) {
  const alice = makeUser({ _id: "ETU-2025-0099", email: "alice@smartcampus.tn", passwordHash: "hash(Correct123)" });
  const repo = new InMemoryUserRepository([alice]);
  const bus = recordingBus();
  const mailer = silentMailer();
  const attempts: boolean[] = [];
  const history = { record: async (_u: unknown, _c: unknown, ok: boolean) => void attempts.push(ok) } as unknown as LoginHistoryService;
  const tokens = new InMemoryTokenRepository();
  const config = { emailDomain: "smartcampus.tn", exposeTempPassword: false, maxAttempts, lockoutMinutes: 15, codeMaxAttempts: 5, emailCooldownSeconds: over.cooldown ?? 60 };
  const users = new UserService({ userRepository: repo, passwordHasher: fakeHasher, mailer, eventBus: bus, sessionStore: noSessions, config });
  const auth = new AuthService({
    userRepository: repo, userService: users, tokenRepository: tokens, sessionService: new SessionService(new InMemoryRefreshTokenRepository(), { ttlDays: 30 }), loginHistoryService: history,
    passwordHasher: fakeHasher, tokenService: fakeTokens, mailer, eventBus: bus, config,
  });
  return { auth, alice, attempts, mailer, repo, tokens };
}

test("connexion réussie : jeton émis, compteur remis à zéro, tentative journalisée", async () => {
  const { auth, alice, attempts } = setup();
  alice.failedAttempts = 2;
  const { token, user } = await auth.login({ email: alice.email, password: "Correct123" }, context);
  assert.equal(token, `token-for-${alice._id}`);
  assert.equal(user.failedAttempts, 0);
  assert.notEqual(user.lastLoginAt, null);
  assert.deepEqual(attempts, [true]);
});

test("échecs successifs : toujours le même 401 (aucun compteur), verrouillage TEMPORAIRE au seuil, révélé au seul titulaire", async () => {
  const { auth, alice, attempts } = setup(3);
  const bad = { email: alice.email, password: "mauvais" };
  const generic = { kind: "unauthorized", details: { code: "INVALID_CREDENTIALS" } };

  await assert.rejects(auth.login(bad, context), generic);
  await assert.rejects(auth.login(bad, context), generic);
  await assert.rejects(auth.login(bad, context), generic); // 3e échec : verrouillé, mais la réponse ne le dit pas
  assert.equal(alice.status, "suspended");
  assert.ok(alice.lockedUntil && alice.lockedUntil.getTime() > Date.now(), "verrouillage daté, pas permanent");

  await assert.rejects(auth.login(bad, context), generic); // compte verrouillé + mauvais mot de passe : toujours le même 401
  assert.equal(alice.failedAttempts, 3, "un compte verrouillé ne compte plus les échecs");
  // Le titulaire (bon mot de passe) apprend la raison et la date de fin.
  await assert.rejects(auth.login({ email: alice.email, password: "Correct123" }, context), (e: { kind?: string; details?: { code?: string; lockedUntil?: string } }) => e.kind === "locked" && e.details?.code === "ACCOUNT_LOCKED" && Boolean(e.details.lockedUntil));
  assert.deepEqual(attempts, [false, false, false, false, false]);
});

test("le verrouillage se lève tout seul à l'échéance (aucun administrateur requis)", async () => {
  const { auth, alice } = setup(2);
  await assert.rejects(auth.login({ email: alice.email, password: "x" }, context));
  await assert.rejects(auth.login({ email: alice.email, password: "x" }, context));
  assert.equal(alice.status, "suspended");
  alice.lockedUntil = new Date(Date.now() - 1000); // échéance dépassée
  const session = await auth.login({ email: alice.email, password: "Correct123" }, context);
  assert.equal(session.user.status, "active");
  assert.equal(session.user.failedAttempts, 0);
  assert.equal(alice.lockedUntil, undefined);
});

test("compte désactivé ou e-mail inconnu : même 401 avec un mauvais mot de passe ; la raison n'est donnée qu'au titulaire", async () => {
  const { auth, alice } = setup();
  alice.status = "inactive";
  const generic = { kind: "unauthorized", details: { code: "INVALID_CREDENTIALS" } };
  await assert.rejects(auth.login({ email: alice.email, password: "faux" }, context), generic);
  await assert.rejects(auth.login({ email: "inconnu@smartcampus.tn", password: "x" }, context), generic);
  await assert.rejects(auth.login({ email: alice.email, password: "Correct123" }, context), { kind: "forbidden", details: { code: "ACCOUNT_INACTIVE" } });
});

test("e-mail inconnu : un hachage est quand même comparé (le temps de réponse ne révèle pas l'existence du compte)", async () => {
  const { auth, alice } = setup();
  let verifications = 0;
  const original = fakeHasher.verify;
  fakeHasher.verify = async (...args) => (verifications++, original(...args));
  try {
    await assert.rejects(auth.login({ email: "inconnu@smartcampus.tn", password: "x" }, context));
    assert.equal(verifications, 1);
    await assert.rejects(auth.login({ email: alice.email, password: "x" }, context));
    assert.equal(verifications, 2, "même travail pour un compte connu et inconnu");
  } finally {
    fakeHasher.verify = original;
  }
});

test("inscription : connexion refusée tant que l'e-mail n'est pas vérifié, puis autorisée", async () => {
  const { auth, tokens } = setup();
  await auth.register({ firstName: "Bob", lastName: "B", email: "bob@smartcampus.tn", password: "Passw0rdOK" });
  await assert.rejects(auth.login({ email: "bob@smartcampus.tn", password: "Passw0rdOK" }, context), { kind: "forbidden", details: { code: "EMAIL_NOT_VERIFIED" } });
  const token = tokens.rows.find((r) => r.email === "bob@smartcampus.tn")!;
  token.hash = sha256("123456");
  await auth.verifyEmail({ email: "bob@smartcampus.tn", code: "123456" });
  const session = await auth.login({ email: "bob@smartcampus.tn", password: "Passw0rdOK" }, context);
  assert.equal(session.user.role, "student");
});

test("code de vérification : 5 essais ratés le détruisent (même le bon code ensuite est refusé)", async () => {
  const { auth, tokens } = setup();
  await auth.register({ firstName: "Bob", lastName: "B", email: "bob@smartcampus.tn", password: "Passw0rdOK" });
  tokens.rows[0]!.hash = sha256("123456");
  for (let i = 0; i < 5; i++) await assert.rejects(auth.verifyEmail({ email: "bob@smartcampus.tn", code: "000000" }), { details: { code: "INVALID_CODE" } });
  assert.equal(tokens.rows.length, 0, "code détruit");
  await assert.rejects(auth.verifyEmail({ email: "bob@smartcampus.tn", code: "123456" }), { details: { code: "INVALID_CODE" } });
});

test("anti-inondation : un nouvel envoi dans le délai est ignoré en silence ; renvoi de code réservé aux comptes en attente", async () => {
  const { auth, alice, mailer } = setup(3, { cooldown: 60 });
  await auth.register({ firstName: "Bob", lastName: "B", email: "bob@smartcampus.tn", password: "Passw0rdOK" });
  await auth.resendActivation({ email: "bob@smartcampus.tn" });
  await auth.resendActivation({ email: "bob@smartcampus.tn" });
  assert.deepEqual(mailer.sent, ["code:bob@smartcampus.tn"], "le renvoi tombe dans le délai de 60 s");
  await auth.resendActivation({ email: alice.email }); // compte déjà vérifié : aucun code
  await auth.forgotPassword({ email: alice.email });
  await auth.forgotPassword({ email: alice.email });
  assert.deepEqual(mailer.sent, ["code:bob@smartcampus.tn", "reset:alice@smartcampus.tn"], "un seul lien dans le délai");
});

test("inscription : toujours étudiant, domaine imposé, mot de passe fort, code envoyé par e-mail", async () => {
  const { auth, mailer } = setup();
  const user = await auth.register({ firstName: "Bob", lastName: "B", email: "bob@smartcampus.tn", password: "Passw0rdOK" });
  assert.equal(user.role, "student");
  assert.deepEqual(mailer.sent, ["code:bob@smartcampus.tn"]);

  await assert.rejects(auth.register({ firstName: "C", lastName: "C", email: "c@gmail.com", password: "Passw0rdOK" }), { details: { code: "INVALID_DOMAIN" } });
  await assert.rejects(auth.register({ firstName: "C", lastName: "C", email: "c@smartcampus.tn", password: "faibleaa" }), { details: { code: "WEAK_PASSWORD" } });
});

test("mot de passe oublié : aucun e-mail pour un compte inconnu ou désactivé, jamais d'erreur", async () => {
  const { auth, alice, mailer } = setup();
  await auth.forgotPassword({ email: "inconnu@smartcampus.tn" });
  alice.status = "inactive";
  await auth.forgotPassword({ email: alice.email });
  assert.deepEqual(mailer.sent, []);
  alice.status = "active";
  await auth.forgotPassword({ email: alice.email });
  assert.deepEqual(mailer.sent, ["reset:alice@smartcampus.tn"]);
});
