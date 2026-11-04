import type { Role } from "../../../shared/constants/index.js";
import { escapeRegExp } from "../../../shared/validation/policies.js";
import { CounterModel, UserModel } from "../models/user.model.js";
import type { NewUser, User, UserFilters, UserPage, UserPatch, UserWithPassword } from "../types/user.types.js";

/** Contrat de persistance des comptes : les services dépendent de ceci, jamais de MongoDB ni de Mongoose. */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByIdWithPassword(id: string): Promise<UserWithPassword | null>;
  findByEmail(email: string): Promise<User | null>;
  findByEmailWithPassword(email: string): Promise<UserWithPassword | null>;
  existsByEmail(email: string): Promise<boolean>;
  existsByEmailAndRole(email: string, role: Role): Promise<boolean>;
  existsNotInactive(email: string): Promise<boolean>;
  create(data: NewUser): Promise<User>;
  /** Applique `patch` ; une valeur `undefined` supprime le champ. Renvoie le compte à jour. */
  update(id: string, patch: UserPatch): Promise<User | null>;
  /** Incrément atomique : pas de perte de comptage sous des tentatives de connexion parallèles. */
  incrementFailedAttempts(id: string): Promise<User | null>;
  updateByEmail(email: string, patch: UserPatch): Promise<void>;
  setRoleByEmail(email: string, role: Role): Promise<User | null>;
  remove(id: string): Promise<void>;
  search(filters?: UserFilters, page?: UserPage): Promise<User[]>;
  count(filters?: UserFilters): Promise<number>;
  countByStatus(): Promise<Record<string, number>>;
  nextSequence(role: Role): Promise<number>;
}

/** Transforme un patch en opérateurs MongoDB : `undefined` → `$unset` (sinon Mongoose ignorerait la clé). */
function toUpdate(patch: UserPatch): Record<string, Record<string, unknown>> {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ""> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) $unset[key] = "";
    else $set[key] = value;
  }
  return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
}

const asUser = (doc: { toObject(): unknown }): User => {
  const { passwordHash: _hash, ...user } = doc.toObject() as UserWithPassword;
  return user;
};

/** Seule couche autorisée à parler à MongoDB pour les comptes. Renvoie des objets simples (`lean`). */
export class MongoUserRepository implements UserRepository {
  findById = (id: string) => UserModel.findById(id).lean<User>().exec();
  findByIdWithPassword = (id: string) => UserModel.findById(id).select("+passwordHash").lean<UserWithPassword>().exec();
  findByEmail = (email: string) => UserModel.findOne({ email }).lean<User>().exec();
  findByEmailWithPassword = (email: string) =>
    UserModel.findOne({ email }).select("+passwordHash").lean<UserWithPassword>().exec();

  existsByEmail = async (email: string) => (await UserModel.exists({ email })) !== null;
  existsByEmailAndRole = async (email: string, role: Role) => (await UserModel.exists({ email, role })) !== null;
  existsNotInactive = async (email: string) => (await UserModel.exists({ email, status: { $ne: "inactive" } })) !== null;

  create = async (data: NewUser) => asUser(await UserModel.create(data));

  update = (id: string, patch: UserPatch) =>
    UserModel.findByIdAndUpdate(id, toUpdate(patch), { new: true }).lean<User>().exec();

  incrementFailedAttempts = (id: string) =>
    UserModel.findByIdAndUpdate(id, { $inc: { failedAttempts: 1 } }, { new: true }).lean<User>().exec();

  updateByEmail = async (email: string, patch: UserPatch) => {
    await UserModel.updateOne({ email }, toUpdate(patch));
  };

  setRoleByEmail = (email: string, role: Role) =>
    UserModel.findOneAndUpdate({ email }, { role }, { new: true }).lean<User>().exec();

  remove = async (id: string) => {
    await UserModel.deleteOne({ _id: id });
  };

  /** Recherche « souple » : `q` est échappé avant d'être transformé en expression régulière. */
  private buildFilter({ q, role, status }: UserFilters): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (q?.trim()) {
      const re = new RegExp(escapeRegExp(q.trim()), "i");
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { _id: re }];
    }
    return filter;
  }

  /** Tri total (date puis matricule) : deux pages consécutives ne se chevauchent jamais, même à dates égales. */
  search(filters: UserFilters = {}, { skip, limit }: UserPage = { skip: 0, limit: 500 }) {
    // Les photos (jusqu'à 100 Ko chacune) ne sont pas renvoyées dans les listes : une page de 500 comptes ferait des dizaines de Mo.
    return UserModel.find(this.buildFilter(filters)).select("-avatarUrl").sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<User[]>().exec();
  }

  count = (filters: UserFilters = {}) => UserModel.countDocuments(this.buildFilter(filters)).exec();

  async countByStatus() {
    const rows = await UserModel.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  async nextSequence(role: Role) {
    const counter = await CounterModel.findOneAndUpdate({ _id: `user-${role}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    return counter.seq;
  }
}
