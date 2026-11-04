import assert from "node:assert/strict";
import { test } from "node:test";
import { UserService } from "../src/modules/users/services/user.service.js";
import { InMemoryUserRepository, fakeHasher, makeUser, noSessions, recordingBus, silentMailer } from "./helpers/fakes.js";

/**
 * Tests unitaires de la couche métier : aucune base, aucun réseau.
 * Possible parce que le service ne dépend que d'interfaces (ports) injectées par le constructeur.
 */

function setup(rows = [makeUser({ _id: "ADM-2026-0001", role: "admin", email: "admin@gmail.com" })]) {
  const repo = new InMemoryUserRepository(rows);
  const bus = recordingBus();
  const mailer = silentMailer();
  const service = new UserService({
    userRepository: repo, passwordHasher: fakeHasher, mailer, eventBus: bus, sessionStore: noSessions,
    config: { emailDomain: "gmail.com", exposeTempPassword: false },
  });
  return { service, repo, bus, mailer, admin: rows[0]! };
}

test("matricule : préfixe du rôle, année courante, séquence sur 4 chiffres", async () => {
  const { service } = setup();
  const user = await service.createAccount({
    firstName: "A", lastName: "B", email: "a@gmail.com", role: "teacher", passwordHash: "x",
  });
  assert.match(user._id, new RegExp(`^ENS-${new Date().getFullYear()}-0001$`));
});

test("création par un admin : e-mail du domaine, mot de passe temporaire envoyé, événement publié", async () => {
  const { service, bus, mailer, admin } = setup();
  const { account, temporaryPassword } = await service.createByAdmin(
    { firstName: "Karim", lastName: "T", email: "karim@gmail.com", role: "teacher" }, admin,
  );
  assert.equal(account.mustChangePassword, true);
  assert.equal(temporaryPassword, undefined, "le mot de passe temporaire n'est exposé qu'avec EXPOSE_TEMP_PASSWORD");
  assert.deepEqual(mailer.sent, ["temp:karim@gmail.com"]);
  assert.deepEqual(bus.events.map((e) => e.name), ["UtilisateurCréé"]);
});

test("le domaine e-mail est imposé et les doublons refusés", async () => {
  const { service, admin } = setup();
  await assert.rejects(
    service.createByAdmin({ firstName: "X", lastName: "Y", email: "x@example.com", role: "teacher" }, admin),
    { kind: "unprocessable", details: { code: "INVALID_DOMAIN" } },
  );
  await assert.rejects(
    service.createByAdmin({ firstName: "X", lastName: "Y", email: "admin@gmail.com", role: "teacher" }, admin),
    { kind: "conflict", details: { code: "EMAIL_EXISTS" } },
  );
});

test("un administrateur ne peut ni changer son rôle, ni se désactiver, ni se supprimer (SELF_PROTECTED)", async () => {
  const { service, bus, admin } = setup();
  const selfProtected = { kind: "conflict", details: { code: "SELF_PROTECTED" } };
  await assert.rejects(service.changeRole(admin._id, "student", admin), selfProtected);
  await assert.rejects(service.changeStatus(admin._id, "inactive", admin), selfProtected);
  await assert.rejects(service.remove(admin._id, admin), selfProtected);
  assert.equal(bus.events.length, 0);
});

test("changer le rôle d'un autre compte publie RôleModifié ; le même rôle ne publie rien", async () => {
  const student = makeUser({ _id: "ETU-2026-0001", email: "e@gmail.com" });
  const { service, bus, admin } = setup([makeUser({ _id: "ADM-2026-0001", role: "admin", email: "admin@gmail.com" }), student]);

  await service.changeRole(student._id, "student", admin);
  assert.equal(bus.events.length, 0);

  const updated = await service.changeRole(student._id, "teacher", admin);
  assert.equal(updated.role, "teacher");
  assert.deepEqual(bus.events.map((e) => e.name), ["RôleModifié"]);
  assert.equal(bus.events[0]!.payload.previous, "student");
});

test("activer un compte suspendu remet le compteur d'échecs à zéro", async () => {
  const locked = makeUser({ _id: "ETU-2026-0002", email: "l@gmail.com", status: "suspended", failedAttempts: 5 });
  const { service, admin } = setup([makeUser({ _id: "ADM-2026-0001", role: "admin" }), locked]);
  const updated = await service.changeStatus(locked._id, "active", admin);
  assert.equal(updated.status, "active");
  assert.equal(updated.failedAttempts, 0);
});

test("changement de mot de passe : ancien requis, différent, assez fort, drapeau levé", async () => {
  const user = makeUser({ mustChangePassword: true, passwordHash: "hash(Old12345)" });
  const { service } = setup([user]);
  await assert.rejects(service.changePassword(user._id, { current: "faux", next: "New12345" }), { details: { code: "WRONG_PASSWORD" } });
  await assert.rejects(service.changePassword(user._id, { current: "Old12345", next: "Old12345" }), { details: { code: "SAME_PASSWORD" } });
  await assert.rejects(service.changePassword(user._id, { current: "Old12345", next: "faible" }), { details: { code: "WEAK_PASSWORD" } });
  await service.changePassword(user._id, { current: "Old12345", next: "New12345" });
  assert.equal(user.passwordHash, "hash(New12345)");
  assert.equal(user.mustChangePassword, false);
});

test("supprimer le téléphone : une valeur vide retire le champ", async () => {
  const user = makeUser({ phone: "12345678" });
  const { service } = setup([user]);
  const updated = await service.updateProfile(user._id, { firstName: "A", lastName: "B", phone: "" });
  assert.equal(updated.phone, undefined);
});

test("dernier administrateur actif : ni rétrogradé, ni désactivé, ni supprimé", async () => {
  const lastAdmin = makeUser({ _id: "ADM-2026-0002", role: "admin", email: "a2@gmail.com" });
  const actor = makeUser({ _id: "ADM-2026-0001", role: "admin", status: "inactive", email: "a1@gmail.com" }); // acteur déjà hors service (course)
  const { service } = setup([actor, lastAdmin]);
  await assert.rejects(service.changeRole(lastAdmin._id, "student", actor), { details: { code: "LAST_ADMIN" } });
  await assert.rejects(service.changeStatus(lastAdmin._id, "inactive", actor), { details: { code: "LAST_ADMIN" } });
  await assert.rejects(service.remove(lastAdmin._id, actor), { details: { code: "LAST_ADMIN" } });
  const second = makeUser({ _id: "ADM-2026-0003", role: "admin", email: "a3@gmail.com" });
  const ok = setup([lastAdmin, second]);
  await ok.service.changeRole(second._id, "student", lastAdmin); // deux admins actifs : permis
});
