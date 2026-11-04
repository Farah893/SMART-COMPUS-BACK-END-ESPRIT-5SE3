import { DOMAIN_EVENTS, TOKEN_TYPES, type TokenType } from "../../../shared/constants/index.js";
import { badRequest, forbidden, locked, unauthorized, unprocessable, type AppError } from "../../../shared/errors/app-error.js";
import type { EventPublisher, MailService, PasswordHasher, TokenService } from "../../../shared/ports/index.js";
import { fullName } from "../../../shared/utils/full-name.js";
import type { RequestContext } from "../../../shared/utils/request-context.js";
import { isStrongPassword } from "../../../shared/validation/policies.js";
import type { Config } from "../../../config/index.js";
import { logger } from "../../../infrastructure/logging/logger.js";
import { randomCode, randomToken, sha256 } from "../../../infrastructure/security/random.js";
import type { LoginHistoryService } from "../../login-history/services/login-history.service.js";
import type { UserRepository } from "../../users/repositories/user.repository.js";
import type { UserService } from "../../users/services/user.service.js";
import type { User, UserWithPassword } from "../../users/types/user.types.js";
import type { EmailDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto, VerifyEmailDto } from "../dto/auth.dto.js";
import type { VerificationTokenRepository } from "../repositories/verification-token.repository.js";
import type { SessionService } from "./session.service.js";

export interface AuthServiceDeps {
  userRepository: UserRepository;
  userService: UserService;
  tokenRepository: VerificationTokenRepository;
  sessionService: SessionService;
  loginHistoryService: LoginHistoryService;
  passwordHasher: PasswordHasher;
  tokenService: TokenService;
  mailer: MailService;
  eventBus: EventPublisher;
  config: Pick<Config, "maxAttempts" | "lockoutMinutes" | "codeMaxAttempts" | "emailCooldownSeconds">;
}

/** Le `iat` des JWT est en secondes : on tronque pour comparer à la même précision (aucun jeton « mort-né »). */
const floorToSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** Authentification et cycle de vie du mot de passe. `context` = { ip, userAgent } fourni par la couche HTTP. */
export class AuthService {
  private readonly users: UserRepository;
  private readonly accounts: UserService;
  private readonly tokens: VerificationTokenRepository;
  private readonly sessions: SessionService;
  private readonly history: LoginHistoryService;
  private readonly hasher: PasswordHasher;
  private readonly jwt: TokenService;
  private readonly mailer: MailService;
  private readonly events: EventPublisher;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly codeMaxAttempts: number;
  private readonly cooldownMs: number;
  /** Hachage factice : comparé quand l'e-mail est inconnu, pour que le temps de réponse ne trahisse pas l'existence du compte. */
  private readonly dummyHash: Promise<string>;

  constructor(deps: AuthServiceDeps) {
    this.users = deps.userRepository;
    this.accounts = deps.userService;
    this.tokens = deps.tokenRepository;
    this.sessions = deps.sessionService;
    this.history = deps.loginHistoryService;
    this.hasher = deps.passwordHasher;
    this.jwt = deps.tokenService;
    this.mailer = deps.mailer;
    this.events = deps.eventBus;
    this.maxAttempts = deps.config.maxAttempts;
    this.lockoutMs = deps.config.lockoutMinutes * 60_000;
    this.codeMaxAttempts = deps.config.codeMaxAttempts;
    this.cooldownMs = deps.config.emailCooldownSeconds * 1000;
    this.dummyHash = this.hasher.hash(randomToken());
  }

  private lockedError(user: Pick<User, "lockedUntil">): AppError {
    return locked("Compte temporairement verrouillé", {
      code: "ACCOUNT_LOCKED",
      ...(user.lockedUntil && { lockedUntil: new Date(user.lockedUntil).toISOString() }),
    });
  }

  /** Un verrouillage échu se lève tout seul : aucune intervention d'un administrateur n'est nécessaire. */
  private async releaseExpiredLock(user: UserWithPassword): Promise<UserWithPassword> {
    if (user.status !== "suspended" || !user.lockedUntil || new Date(user.lockedUntil) > new Date()) return user;
    const released = await this.users.update(user._id, { status: "active", failedAttempts: 0, lockedUntil: undefined });
    return released ? { ...user, ...released, lockedUntil: undefined } : user;
  }

  /** Échec de mot de passe sur un compte existant : comptage atomique, puis verrouillage TEMPORAIRE au seuil. */
  private async recordFailure(user: User, context: RequestContext): Promise<void> {
    if (user.status !== "active") return void (await this.history.record(user, context, false)); // pas de comptage hors compte actif
    let current = (await this.users.incrementFailedAttempts(user._id)) ?? user;
    if (current.failedAttempts >= this.maxAttempts) {
      current = (await this.users.update(user._id, { status: "suspended", lockedUntil: new Date(Date.now() + this.lockoutMs) })) ?? current;
    }
    await this.history.record(current, context, false);
  }

  /** Envoi sans attendre le serveur SMTP : le temps de réponse ne dépend pas de l'existence du compte. */
  private deliver(sending: Promise<void>, what: string): void {
    sending.catch((err: unknown) => logger.warn({ err, what }, "envoi d'e-mail échoué"));
  }

  private async onCooldown(email: string, type: TokenType): Promise<boolean> {
    const active = await this.tokens.findActive({ email, type });
    return active?.createdAt !== undefined && Date.now() - new Date(active.createdAt).getTime() < this.cooldownMs;
  }

  private issueToken(email: string, type: TokenType, value: string, minutes: number): Promise<void> {
    return this.tokens.replace({ email, type, hash: sha256(value), expiresAt: new Date(Date.now() + minutes * 60_000) });
  }

  /**
   * Une seule réponse (401 « identifiants invalides ») pour e-mail inconnu, mauvais mot de passe, compte verrouillé ou
   * désactivé : un attaquant n'apprend rien sur les comptes. Le titulaire (mot de passe correct) apprend la raison :
   * 423 verrouillé (jusqu'à `lockedUntil`) · 403 désactivé · 403 e-mail non vérifié.
   */
  async login({ email, password }: LoginDto, context: RequestContext): Promise<{ token: string; refreshToken: string; user: User }> {
    const stored = await this.users.findByEmailWithPassword(email);
    const found = stored ? await this.releaseExpiredLock(stored) : null;
    // Un hachage est TOUJOURS comparé, même pour un e-mail inconnu : le temps de réponse ne trahit pas l'existence du compte.
    const valid = await this.hasher.verify(password, found?.passwordHash ?? (await this.dummyHash));
    if (!found || !valid) {
      if (found) await this.recordFailure(found, context);
      throw unauthorized("Identifiants invalides", { code: "INVALID_CREDENTIALS" });
    }
    const { passwordHash: _hash, ...user } = found;

    if (user.status === "suspended") {
      await this.history.record(user, context, false);
      throw this.lockedError(user);
    }
    if (user.status === "inactive") throw forbidden("Compte désactivé", { code: "ACCOUNT_INACTIVE" });
    if (user.verificationPending) throw forbidden("Adresse e-mail non vérifiée", { code: "EMAIL_NOT_VERIFIED" });

    const updated = (await this.users.update(user._id, { failedAttempts: 0, lastLoginAt: new Date() })) ?? user;
    await this.history.record(updated, context, true);
    return { token: this.jwt.sign(updated), refreshToken: await this.sessions.open(updated._id), user: updated };
  }

  /** Échange un jeton de rafraîchissement contre un nouveau jeton d'accès ET un nouveau jeton de rafraîchissement. */
  async refresh({ refreshToken }: RefreshDto): Promise<{ token: string; refreshToken: string; user: User }> {
    const rotated = await this.sessions.rotate(refreshToken);
    const user = await this.users.findById(rotated.userId);
    // Compte supprimé, désactivé ou suspendu depuis la dernière connexion : la session s'arrête là.
    if (!user || user.status !== "active") {
      await this.sessions.closeFamily(rotated.familyId);
      throw unauthorized("Session invalide ou expirée", { code: "INVALID_REFRESH_TOKEN" });
    }
    return { token: this.jwt.sign(user), refreshToken: rotated.refreshToken, user };
  }

  /** Termine la session portant ce jeton. Répond toujours OK (idempotent, ne révèle rien). */
  logout({ refreshToken }: RefreshDto): Promise<void> {
    return this.sessions.close(refreshToken);
  }

  /** Déconnecte le compte partout : sessions longues terminées ET jetons d'accès déjà émis refusés. */
  async logoutAll(user: User): Promise<void> {
    await this.sessions.closeAll(user._id);
    await this.users.update(user._id, { tokensValidAfter: floorToSecond(new Date()) });
  }

  /** Toujours un compte étudiant (le rôle envoyé est ignoré par le DTO). */
  async register({ firstName, lastName, email, password }: RegisterDto): Promise<User> {
    this.accounts.assertInstitutionalEmail(email);
    if (!isStrongPassword(password)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
    await this.accounts.assertEmailAvailable(email);

    const user = await this.accounts.createAccount({
      firstName, lastName, email, role: "student", passwordHash: await this.hasher.hash(password),
      emailVerified: false, verificationPending: true, // connexion refusée tant que le code e-mail n'est pas saisi
    });
    await this.events.publish(DOMAIN_EVENTS.USER_CREATED, { id: user._id, email, role: user.role, name: fullName(user) });
    await this.sendVerificationCode(email);
    return user;
  }

  private async sendVerificationCode(email: string): Promise<void> {
    const code = randomCode();
    await this.issueToken(email, TOKEN_TYPES.VERIFY_EMAIL, code, 15);
    this.deliver(this.mailer.sendVerificationCode(email, code), "verification-code");
  }

  /** Au-delà de `codeMaxAttempts` essais ratés, le code est détruit : il faut en demander un nouveau. */
  async verifyEmail({ email, code }: VerifyEmailDto): Promise<void> {
    const active = await this.tokens.findActive({ email, type: TOKEN_TYPES.VERIFY_EMAIL });
    if (!active) throw badRequest("Code invalide ou expiré", { code: "INVALID_CODE" });
    if (active.hash !== sha256(code)) {
      if ((await this.tokens.recordFailure(active.id)) >= this.codeMaxAttempts) await this.tokens.remove(active.id);
      throw badRequest("Code invalide ou expiré", { code: "INVALID_CODE" });
    }
    await Promise.all([this.tokens.remove(active.id), this.users.updateByEmail(email, { emailVerified: true, verificationPending: false })]);
  }

  /** Ne révèle pas l'existence du compte ; ne renvoie un code qu'aux comptes en attente, et pas plus d'une fois par délai. */
  async resendActivation({ email }: EmailDto): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user?.verificationPending) return;
    if (await this.onCooldown(email, TOKEN_TYPES.VERIFY_EMAIL)) return;
    await this.sendVerificationCode(email);
  }

  /** Ne révèle pas l'existence du compte ; rien pour un compte désactivé ; un lien encore frais n'est pas remplacé (anti-inondation). */
  async forgotPassword({ email }: EmailDto): Promise<void> {
    if (!(await this.users.existsNotInactive(email))) return;
    if (await this.onCooldown(email, TOKEN_TYPES.RESET_PASSWORD)) return;
    const token = randomToken();
    await this.issueToken(email, TOKEN_TYPES.RESET_PASSWORD, token, 60);
    this.deliver(this.mailer.sendResetLink(email, token), "reset-link");
  }

  async resetPassword({ email, token, password }: ResetPasswordDto): Promise<void> {
    const doc = await this.tokens.findValid({ email, type: TOKEN_TYPES.RESET_PASSWORD, hash: sha256(token) });
    if (!doc) throw badRequest("Lien de réinitialisation invalide ou expiré", { code: "INVALID_TOKEN" });
    if (!isStrongPassword(password)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
    const account = await this.users.findByEmail(email);
    await this.users.updateByEmail(email, {
      passwordHash: await this.hasher.hash(password),
      mustChangePassword: false,
      // Après une réinitialisation (mot de passe peut-être compromis), tout ce qui existait est invalidé.
      tokensValidAfter: floorToSecond(new Date()),
    });
    if (account) await this.sessions.closeAll(account._id);
    await this.tokens.remove(doc.id);
  }
}
