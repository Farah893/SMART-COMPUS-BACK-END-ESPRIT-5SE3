import { DOMAIN_EVENTS, MATRICULE_PREFIX, type Role, type UserStatus } from "../../../shared/constants/index.js";
import { conflict, notFound, unauthorized, unprocessable } from "../../../shared/errors/app-error.js";
import type { EventPublisher, MailService, PasswordHasher, SessionStore } from "../../../shared/ports/index.js";
import { fullName } from "../../../shared/utils/full-name.js";
import { isInstitutionalEmail, isStrongPassword } from "../../../shared/validation/policies.js";
import type { Config } from "../../../config/index.js";
import { generateTemporaryPassword } from "../../../infrastructure/security/random.js";
import type { AdminCreateUserDto, ChangePasswordDto, UpdateProfileDto, UserListResult } from "../dto/user.dto.js";
import type { UserRepository } from "../repositories/user.repository.js";
import type { User, UserFilters, UserPatch, UserStats } from "../types/user.types.js";

/** Taille de page maximale (et par défaut) : identique à l'ancienne limite fixe. */
export const MAX_PAGE_SIZE = 500;

export interface UserServiceDeps {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  mailer: MailService;
  eventBus: EventPublisher;
  sessionStore: SessionStore;
  config: Pick<Config, "emailDomain" | "exposeTempPassword">;
}

export interface CreateAccountInput {
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  passwordHash: string;
  mustChangePassword?: boolean;
  emailVerified?: boolean;
  verificationPending?: boolean;
}

/** Règles métier des comptes. Ne connaît ni Express ni MongoDB : il passe par le dépôt et les ports injectés. */
export class UserService {
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly mailer: MailService;
  private readonly events: EventPublisher;
  private readonly sessions: SessionStore;
  private readonly config: UserServiceDeps["config"];

  constructor(deps: UserServiceDeps) {
    this.users = deps.userRepository;
    this.hasher = deps.passwordHasher;
    this.mailer = deps.mailer;
    this.events = deps.eventBus;
    this.sessions = deps.sessionStore;
    this.config = deps.config;
  }

  /* ---------------------------- création de comptes ---------------------------- */

  /** Matricule : ETU-2026-0001 (séquence par rôle, atomique). */
  private async nextMatricule(role: Role): Promise<string> {
    const seq = await this.users.nextSequence(role);
    return `${MATRICULE_PREFIX[role]}-${new Date().getFullYear()}-${String(seq).padStart(4, "0")}`;
  }

  async createAccount(input: CreateAccountInput): Promise<User> {
    return this.users.create({
      ...input,
      _id: await this.nextMatricule(input.role),
      mustChangePassword: input.mustChangePassword ?? false,
      emailVerified: input.emailVerified ?? true, // compte créé par un administrateur ou amorcé : l'adresse est de confiance
    });
  }

  assertInstitutionalEmail(email: string): void {
    if (!isInstitutionalEmail(email)) {
      throw unprocessable(`Adresse @${this.config.emailDomain} requise`, { code: "INVALID_DOMAIN" });
    }
  }

  async assertEmailAvailable(email: string): Promise<void> {
    if (await this.users.existsByEmail(email)) {
      throw conflict("Un compte existe déjà avec cette adresse", { code: "EMAIL_EXISTS" });
    }
  }

  /** Création par un administrateur : mot de passe temporaire envoyé par e-mail, changement obligatoire. */
  async createByAdmin(
    { firstName, lastName, email, role }: AdminCreateUserDto,
    actor: User,
  ): Promise<{ account: User; temporaryPassword?: string }> {
    this.assertInstitutionalEmail(email);
    await this.assertEmailAvailable(email);

    const temporary = generateTemporaryPassword();
    const account = await this.createAccount({
      firstName, lastName, email, role, passwordHash: await this.hasher.hash(temporary), mustChangePassword: true,
    });
    await this.events.publish(DOMAIN_EVENTS.USER_CREATED, {
      id: account._id, email, role, name: fullName(account), createdBy: actor._id,
    });
    await this.mailer.sendTemporaryPassword(account, temporary);
    return { account, temporaryPassword: this.config.exposeTempPassword ? temporary : undefined };
  }

  /* --------------------------------- lecture --------------------------------- */

  async getById(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw notFound();
    return user;
  }

  /** Sans `page`/`limit` : page 1 de 500 comptes maximum, comme avant la pagination. */
  async list({ page = 1, limit = MAX_PAGE_SIZE, ...filters }: UserFilters & { page?: number; limit?: number }): Promise<UserListResult> {
    const size = Math.min(limit, MAX_PAGE_SIZE);
    const [items, stats, total] = await Promise.all([
      this.users.search(filters, { skip: (page - 1) * size, limit: size }),
      this.stats(),
      this.users.count(filters),
    ]);
    return { items, stats, page, limit: size, total };
  }

  async stats(): Promise<UserStats> {
    const by = await this.users.countByStatus();
    const active = by.active ?? 0, inactive = by.inactive ?? 0, suspended = by.suspended ?? 0;
    return { total: active + inactive + suspended, active, inactive, suspended };
  }

  /* -------------------------------- modification ------------------------------- */

  /** Applique un patch sur un compte existant (404 s'il a disparu entre-temps). */
  private async apply(id: string, patch: UserPatch): Promise<User> {
    const updated = await this.users.update(id, patch);
    if (!updated) throw notFound();
    return updated;
  }

  async updateProfile(id: string, { firstName, lastName, phone }: UpdateProfileDto): Promise<User> {
    await this.getById(id);
    return this.apply(id, { firstName, lastName, phone: phone || undefined });
  }

  async updateAvatar(id: string, avatarUrl: string | null): Promise<User> {
    await this.getById(id);
    return this.apply(id, { avatarUrl: avatarUrl ?? undefined });
  }

  async changePassword(id: string, { current, next }: ChangePasswordDto): Promise<void> {
    const user = await this.users.findByIdWithPassword(id);
    if (!user) throw notFound();
    if (!(await this.hasher.verify(current, user.passwordHash))) {
      throw unauthorized("Mot de passe actuel incorrect", { code: "WRONG_PASSWORD" });
    }
    if (next === current) throw unprocessable("Le nouveau mot de passe doit être différent de l'actuel", { code: "SAME_PASSWORD" });
    if (!isStrongPassword(next)) throw unprocessable("Mot de passe trop faible", { code: "WEAK_PASSWORD" });
    await this.apply(id, { passwordHash: await this.hasher.hash(next), mustChangePassword: false });
    // Les sessions longues (refresh) prennent fin ; le jeton d'accès courant reste valable jusqu'à son expiration :
    // l'utilisateur qui vient de changer son mot de passe temporaire poursuit sa session sans se reconnecter.
    await this.sessions.closeAll(id);
  }

  /** Un administrateur ne peut pas se retirer ses propres droits ni son accès (évite le verrouillage). */
  private assertNotSelf(id: string, actor: User, what: string): void {
    if (id === actor._id) throw conflict(`Vous ne pouvez pas ${what} votre propre compte`, { code: "SELF_PROTECTED" });
  }

  /** Il doit toujours rester un administrateur actif : deux administrateurs ne peuvent pas se retirer l'accès mutuellement. */
  private async assertNotLastAdmin(user: User): Promise<void> {
    if (user.role !== "admin" || user.status !== "active") return;
    if ((await this.users.count({ role: "admin", status: "active" })) <= 1) {
      throw conflict("Il doit rester au moins un administrateur actif", { code: "LAST_ADMIN" });
    }
  }

  async changeRole(id: string, role: Role, actor: User): Promise<User> {
    const user = await this.getById(id);
    if (user.role === role) return user;
    this.assertNotSelf(id, actor, "modifier le rôle de");
    if (role !== "admin") await this.assertNotLastAdmin(user);
    const updated = await this.apply(id, { role });
    await this.events.publish(DOMAIN_EVENTS.ROLE_CHANGED, {
      id: updated._id, email: updated.email, previous: user.role, role, changedBy: actor._id,
    });
    return updated;
  }

  /** Activer remet `failedAttempts` à 0 (déverrouille un compte suspendu). */
  async changeStatus(id: string, status: Extract<UserStatus, "active" | "inactive">, actor: User): Promise<User> {
    const user = await this.getById(id);
    if (status === "inactive") {
      this.assertNotSelf(id, actor, "désactiver");
      await this.assertNotLastAdmin(user);
    }
    return this.apply(id, { status, ...(status === "active" && { failedAttempts: 0, lockedUntil: undefined }) });
  }

  async remove(id: string, actor: User): Promise<void> {
    const user = await this.getById(id);
    this.assertNotSelf(id, actor, "supprimer");
    await this.assertNotLastAdmin(user);
    await this.users.remove(id);
  }
}
