import type { EventPublisher, MailService, PasswordHasher, SessionStore, TokenService } from "../../src/shared/ports/index.js";
import type { RefreshTokenEntity } from "../../src/modules/auth/models/refresh-token.model.js";
import type { RefreshTokenRepository } from "../../src/modules/auth/repositories/refresh-token.repository.js";
import type { ActiveToken, VerificationTokenRepository } from "../../src/modules/auth/repositories/verification-token.repository.js";
import type { TokenEntity } from "../../src/modules/auth/models/verification-token.model.js";
import type { UserFilters } from "../../src/modules/users/types/user.types.js";
import type { UserRepository } from "../../src/modules/users/repositories/user.repository.js";
import type { NewUser, User, UserPatch, UserWithPassword } from "../../src/modules/users/types/user.types.js";

/** Doublures en mémoire des ports : les services se testent sans base, sans réseau, sans horloge cachée. */

export const makeUser = (over: Partial<UserWithPassword> = {}): UserWithPassword => ({
  _id: "ETU-2026-0001",
  firstName: "Test",
  lastName: "User",
  email: "test@smartcampus.tn",
  role: "student",
  status: "active",
  failedAttempts: 0,
  lastLoginAt: null,
  mustChangePassword: false,
  emailVerified: false,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  passwordHash: "hash(secret)",
  ...over,
});

export class InMemoryUserRepository implements UserRepository {
  private seq = 0;
  constructor(readonly rows: UserWithPassword[] = []) {}

  private strip = ({ passwordHash: _h, ...user }: UserWithPassword): User => user;
  private byId = (id: string) => this.rows.find((u) => u._id === id);

  findById = async (id: string) => { const u = this.byId(id); return u ? this.strip(u) : null; };
  findByIdWithPassword = async (id: string) => this.byId(id) ?? null;
  findByEmail = async (email: string) => { const u = this.rows.find((r) => r.email === email); return u ? this.strip(u) : null; };
  findByEmailWithPassword = async (email: string) => this.rows.find((u) => u.email === email) ?? null;
  existsByEmail = async (email: string) => this.rows.some((u) => u.email === email);
  existsByEmailAndRole = async (email: string, role: User["role"]) => this.rows.some((u) => u.email === email && u.role === role);
  existsNotInactive = async (email: string) => this.rows.some((u) => u.email === email && u.status !== "inactive");

  create = async (data: NewUser) => {
    const row = makeUser({ ...data });
    this.rows.push(row);
    return this.strip(row);
  };

  update = async (id: string, patch: UserPatch) => {
    const u = this.byId(id);
    if (!u) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (u as unknown as Record<string, unknown>)[k];
      else (u as unknown as Record<string, unknown>)[k] = v;
    }
    return this.strip(u);
  };

  incrementFailedAttempts = async (id: string) => {
    const u = this.byId(id);
    if (!u) return null;
    u.failedAttempts += 1;
    return this.strip(u);
  };

  updateByEmail = async (email: string, patch: UserPatch) => {
    const u = this.rows.find((r) => r.email === email);
    if (u) await this.update(u._id, patch);
  };
  setRoleByEmail = async (email: string, role: User["role"]) => {
    const u = this.rows.find((r) => r.email === email);
    return u ? this.update(u._id, { role }) : null;
  };
  remove = async (id: string) => { this.rows.splice(0, this.rows.length, ...this.rows.filter((u) => u._id !== id)); };
  search = async () => this.rows.map(this.strip);
  count = async (f: UserFilters = {}) => this.rows.filter((u) => (!f.role || u.role === f.role) && (!f.status || u.status === f.status)).length;
  countByStatus = async () => ({});
  nextSequence = async () => ++this.seq;
}

export const fakeHasher: PasswordHasher = {
  hash: async (plain) => `hash(${plain})`,
  verify: async (plain, hash) => hash === `hash(${plain})`,
};

export const fakeTokens: TokenService = {
  sign: (user) => `token-for-${user._id}`,
  jwks: () => ({ keys: [] }),
  verify: (token) => ({ sub: token.replace("token-for-", ""), name: "x", role: "student" }),
};

export const silentMailer = (): MailService & { sent: string[] } => {
  const sent: string[] = [];
  return {
    sent,
    sendTemporaryPassword: async (u) => void sent.push(`temp:${u.email}`),
    sendVerificationCode: async (e) => void sent.push(`code:${e}`),
    sendResetLink: async (e) => void sent.push(`reset:${e}`),
  };
};

export const recordingBus = (): EventPublisher & { events: Array<{ name: string; payload: Record<string, unknown> }> } => {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  return { events, publish: async (name, payload) => void events.push({ name, payload }) };
};

/** Dépôt de jetons de rafraîchissement en mémoire (mêmes règles que Mongo : consommation atomique, révocation par famille). */
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  readonly rows: RefreshTokenEntity[] = [];
  create = async (t: RefreshTokenEntity) => void this.rows.push({ ...t, usedAt: null, revokedAt: null });
  findByHash = async (hash: string) => this.rows.find((r) => r.hash === hash) ?? null;
  claim = async (hash: string) => {
    const r = this.rows.find((x) => x.hash === hash && !x.usedAt && !x.revokedAt && x.expiresAt > new Date());
    if (!r) return null;
    r.usedAt = new Date();
    return r;
  };
  revokeFamily = async (familyId: string) => void this.rows.filter((r) => r.familyId === familyId).forEach((r) => (r.revokedAt ??= new Date()));
  revokeAllForUser = async (userId: string) => void this.rows.filter((r) => r.userId === userId).forEach((r) => (r.revokedAt ??= new Date()));
}

/** Dépôt de jetons de vérification en mémoire (compteur d'essais et date d'émission, comme Mongo). */
export class InMemoryTokenRepository implements VerificationTokenRepository {
  readonly rows: Array<TokenEntity & { id: string }> = [];
  private n = 0;
  replace = async (t: TokenEntity) => {
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.email === t.email && r.type === t.type)));
    this.rows.push({ ...t, id: String(++this.n), attempts: 0, createdAt: new Date() });
  };
  findValid = async ({ email, type, hash }: { email: string; type: string; hash: string }) => {
    const r = this.rows.find((x) => x.email === email && x.type === type && x.hash === hash && x.expiresAt > new Date());
    return r ? { id: r.id } : null;
  };
  findActive = async ({ email, type }: { email: string; type: string }): Promise<ActiveToken | null> => {
    const r = this.rows.find((x) => x.email === email && x.type === type && x.expiresAt > new Date());
    return r ? { id: r.id, hash: r.hash, attempts: r.attempts ?? 0, createdAt: r.createdAt } : null;
  };
  recordFailure = async (id: string) => {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return Number.MAX_SAFE_INTEGER;
    r.attempts = (r.attempts ?? 0) + 1;
    return r.attempts;
  };
  remove = async (id: string) => void this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => r.id !== id));
}

export const noSessions: SessionStore = { closeAll: async () => {} };
