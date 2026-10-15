import { Router } from "express";
import { Token, User } from "../models/index.js";
import { createAccount, logLogin, fullName, MAX_ATTEMPTS } from "../services/accounts.js";
import { publishEvent } from "../services/events.js";
import { sendResetLink, sendVerificationCode } from "../services/mailer.js";
import { badRequest, conflict, forbidden, unauthorized, unprocessable, wrap, HttpError } from "../utils/errors.js";
import { hashPassword, randomCode, randomToken, sha256, signToken, verifyPassword } from "../utils/security.js";
import { isInstitutionalEmail, isStrongPassword, parse, schemas } from "../utils/validation.js";
import { config } from "../config.js";

export const authRouter = Router();

const locked = (u) =>
  new HttpError(423, "Compte suspendu", { code: "ACCOUNT_LOCKED", failedAttempts: u.failedAttempts, max: MAX_ATTEMPTS });

async function issueToken(email, type, value, minutes) {
  await Token.deleteMany({ email, type });
  await Token.create({ email, type, hash: sha256(value), expiresAt: new Date(Date.now() + minutes * 60_000) });
}

/** POST /auth/login → { token, user } · 401 · 403 compte désactivé · 423 compte verrouillé */
authRouter.post("/login", wrap(async (req, res) => {
  const { email, password } = parse(schemas.login, req.body);
  const user = await User.findOne({ email }).select("+passwordHash");
  if (!user) throw unauthorized("Identifiants invalides", { code: "INVALID_CREDENTIALS" });

  if (user.status === "suspended") {
    await logLogin(user, req, false);
    throw locked(user);
  }
  if (user.status === "inactive") throw forbidden("Compte désactivé", { code: "ACCOUNT_INACTIVE" });

  if (!(await verifyPassword(password, user.passwordHash))) {
    user.failedAttempts += 1;
    if (user.failedAttempts >= MAX_ATTEMPTS) user.status = "suspended";
    await user.save();
    await logLogin(user, req, false);
    if (user.status === "suspended") throw locked(user);
    throw unauthorized("Identifiants invalides", { code: "INVALID_CREDENTIALS", failedAttempts: user.failedAttempts, max: MAX_ATTEMPTS });
  }

  user.failedAttempts = 0;
  user.lastLoginAt = new Date();
  await user.save();
  await logLogin(user, req, true);
  res.json({
    token: signToken(user),
    user: {
      id: user._id, name: fullName(user), email: user.email, role: user.role,
      avatarUrl: user.avatarUrl, mustChangePassword: user.mustChangePassword || undefined,
    },
  });
}));

/** POST /auth/register — toujours un compte étudiant (le rôle envoyé est ignoré). */
authRouter.post("/register", wrap(async (req, res) => {
  const { firstName, lastName, email, password } = parse(schemas.register, req.body);
  if (!isInstitutionalEmail(email)) throw unprocessable(`Adresse @${config.emailDomain} requise`, { code: "INVALID_DOMAIN" });
  if (!isStrongPassword(password)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
  if (await User.exists({ email })) throw conflict("Un compte existe déjà avec cette adresse", { code: "EMAIL_EXISTS" });

  const user = await createAccount({ firstName, lastName, email, role: "student", passwordHash: await hashPassword(password) });
  publishEvent("UtilisateurCréé", { id: user._id, email, role: user.role, name: fullName(user) });

  const code = randomCode();
  await issueToken(email, "verify-email", code, 15);
  await sendVerificationCode(email, code);
  res.status(201).json(user);
}));

/** POST /auth/verify-email — code à 6 chiffres reçu par e-mail. */
authRouter.post("/verify-email", wrap(async (req, res) => {
  const { email, code } = parse(schemas.verifyEmail, req.body);
  const token = await Token.findOne({ email, type: "verify-email", hash: sha256(code), expiresAt: { $gt: new Date() } });
  if (!token) throw badRequest("Code invalide ou expiré", { code: "INVALID_CODE" });
  await Promise.all([token.deleteOne(), User.updateOne({ email }, { emailVerified: true })]);
  res.json({ ok: true });
}));

/** POST /auth/resend-activation — répond toujours OK. */
authRouter.post("/resend-activation", wrap(async (req, res) => {
  const { email } = parse(schemas.email, req.body);
  if (await User.exists({ email })) {
    const code = randomCode();
    await issueToken(email, "verify-email", code, 15);
    await sendVerificationCode(email, code);
  }
  res.json({ ok: true });
}));

/** POST /auth/forgot-password — répond toujours OK (ne révèle pas l'existence du compte). */
authRouter.post("/forgot-password", wrap(async (req, res) => {
  const { email } = parse(schemas.email, req.body);
  if (await User.exists({ email, status: { $ne: "inactive" } })) {
    const token = randomToken();
    await issueToken(email, "reset-password", token, 60);
    await sendResetLink(email, token);
  }
  res.json({ ok: true });
}));

/** POST /auth/reset-password */
authRouter.post("/reset-password", wrap(async (req, res) => {
  const { email, token, password } = parse(schemas.resetPassword, req.body);
  const doc = await Token.findOne({ email, type: "reset-password", hash: sha256(token), expiresAt: { $gt: new Date() } });
  if (!doc) throw badRequest("Lien de réinitialisation invalide ou expiré", { code: "INVALID_TOKEN" });
  if (!isStrongPassword(password)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
  await User.updateOne({ email }, { passwordHash: await hashPassword(password), mustChangePassword: false });
  await doc.deleteOne();
  res.json({ ok: true });
}));
