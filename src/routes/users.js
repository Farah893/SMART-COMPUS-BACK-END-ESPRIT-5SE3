import { Router } from "express";
import { LoginEvent, User } from "../models/index.js";
import { authenticate, requireAdmin, selfOrAdmin } from "../middleware/auth.js";
import { createAccount, fullName, userStats } from "../services/accounts.js";
import { publishEvent } from "../services/events.js";
import { sendTemporaryPassword } from "../services/mailer.js";
import { config } from "../config.js";
import { conflict, forbidden, notFound, unauthorized, unprocessable, wrap } from "../utils/errors.js";
import { generateTemporaryPassword, hashPassword, verifyPassword } from "../utils/security.js";
import { isInstitutionalEmail, isStrongPassword, parse, ROLES, schemas } from "../utils/validation.js";

export const usersRouter = Router();
usersRouter.use(authenticate);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const find = async (id) => (await User.findById(id)) ?? Promise.reject(notFound());

/** Un administrateur ne peut pas se retirer ses propres droits ni son accès (évite le verrouillage). */
const notSelf = (req, what) => {
  if (req.params.id === req.user._id) throw conflict(`Vous ne pouvez pas ${what} votre propre compte`, { code: "SELF_PROTECTED" });
};

/** POST /users (admin) — crée le compte avec un mot de passe temporaire envoyé par e-mail. */
usersRouter.post("/", requireAdmin, wrap(async (req, res) => {
  const { firstName, lastName, email, role } = parse(schemas.adminCreate, req.body);
  if (!isInstitutionalEmail(email)) throw unprocessable(`Adresse @${config.emailDomain} requise`, { code: "INVALID_DOMAIN" });
  if (await User.exists({ email })) throw conflict("Un compte existe déjà avec cette adresse", { code: "EMAIL_EXISTS" });

  const temporary = generateTemporaryPassword();
  const account = await createAccount({
    firstName, lastName, email, role, passwordHash: await hashPassword(temporary), mustChangePassword: true,
  });
  publishEvent("UtilisateurCréé", { id: account._id, email, role, name: fullName(account), createdBy: req.user._id });
  await sendTemporaryPassword(account, temporary);
  res.status(201).json({ account, ...(config.exposeTempPassword && { demoTemporaryPassword: temporary }) });
}));

/** GET /users?q=&role=&status= (admin) → { items, stats } */
usersRouter.get("/", requireAdmin, wrap(async (req, res) => {
  const { q, role, status } = req.query;
  const filter = {};
  if (typeof role === "string" && ROLES.includes(role)) filter.role = role;
  if (typeof status === "string" && ["active", "inactive", "suspended"].includes(status)) filter.status = status;
  if (typeof q === "string" && q.trim()) {
    const re = new RegExp(escapeRe(q.trim()), "i");
    filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { _id: re }];
  }
  const [items, stats] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).limit(500), userStats()]);
  res.json({ items, stats });
}));

/** GET /users/:id (soi-même ou admin) */
usersRouter.get("/:id", selfOrAdmin, wrap(async (req, res) => res.json(await find(req.params.id))));

/** PUT /users/:id — profil { firstName, lastName, phone? } */
usersRouter.put("/:id", selfOrAdmin, wrap(async (req, res) => {
  const { firstName, lastName, phone } = parse(schemas.profile, req.body);
  const user = await find(req.params.id);
  Object.assign(user, { firstName, lastName, phone: phone || undefined });
  res.json(await user.save());
}));

/** PUT /users/:id/password — soi-même. 401 WRONG_PASSWORD · 422 SAME_PASSWORD / WEAK_PASSWORD */
usersRouter.put("/:id/password", wrap(async (req, res) => {
  if (req.params.id !== req.user._id) throw forbidden();
  const { current, next } = parse(schemas.changePassword, req.body);
  const user = await User.findById(req.params.id).select("+passwordHash");
  if (!user) throw notFound();
  if (!(await verifyPassword(current, user.passwordHash))) throw unauthorized("Mot de passe actuel incorrect", { code: "WRONG_PASSWORD" });
  if (next === current) throw unprocessable("Le nouveau mot de passe doit être différent de l'actuel", { code: "SAME_PASSWORD" });
  if (!isStrongPassword(next)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
  user.passwordHash = await hashPassword(next);
  user.mustChangePassword = false;
  await user.save();
  res.json({ ok: true });
}));

/** PUT /users/:id/avatar — { avatarUrl | null } (soi-même) */
usersRouter.put("/:id/avatar", wrap(async (req, res) => {
  if (req.params.id !== req.user._id) throw forbidden();
  const { avatarUrl } = parse(schemas.avatar, req.body);
  const user = await find(req.params.id);
  user.avatarUrl = avatarUrl ?? undefined;
  res.json(await user.save());
}));

/** PUT /users/:id/role (admin) — publie RôleModifié */
usersRouter.put("/:id/role", requireAdmin, wrap(async (req, res) => {
  const { role } = parse(schemas.role, req.body);
  const user = await find(req.params.id);
  if (user.role !== role) {
    notSelf(req, "modifier le rôle de");
    const previous = user.role;
    user.role = role;
    await user.save();
    publishEvent("RôleModifié", { id: user._id, email: user.email, previous, role, changedBy: req.user._id });
  }
  res.json(user);
}));

/** PATCH /users/:id/status (admin) — active (réinitialise les échecs) ou désactive */
usersRouter.patch("/:id/status", requireAdmin, wrap(async (req, res) => {
  const { status } = parse(schemas.status, req.body);
  const user = await find(req.params.id);
  if (status === "inactive") notSelf(req, "désactiver");
  user.status = status;
  if (status === "active") user.failedAttempts = 0;
  res.json(await user.save());
}));

/** DELETE /users/:id (admin) */
usersRouter.delete("/:id", requireAdmin, wrap(async (req, res) => {
  const user = await find(req.params.id);
  notSelf(req, "supprimer");
  await user.deleteOne();
  res.status(204).end();
}));

/** GET /users/:id/login-history (soi-même ou admin) */
usersRouter.get("/:id/login-history", selfOrAdmin, wrap(async (req, res) => {
  res.json(await LoginEvent.find({ userId: req.params.id, ...resultFilter(req) }).sort({ date: -1 }).limit(200));
}));

export const resultFilter = (req) =>
  req.query.result === "success" ? { success: true } : req.query.result === "failure" ? { success: false } : {};
