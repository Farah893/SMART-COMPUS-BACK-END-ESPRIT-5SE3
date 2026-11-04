import type { TokenType } from "../../../shared/constants/index.js";
import { Token, type TokenEntity } from "../models/verification-token.model.js";

export interface VerificationTokenRepository {
  /** Un seul jeton actif par (e-mail, type) : le précédent est invalidé. */
  replace(token: TokenEntity): Promise<void>;
  findValid(query: { email: string; type: TokenType; hash: string }): Promise<{ id: string } | null>;
  /** Jeton non expiré de cet (e-mail, type), avec son compteur d'essais et sa date d'émission. */
  findActive(query: { email: string; type: TokenType }): Promise<ActiveToken | null>;
  /** Incrément atomique ; renvoie le nombre d'essais ratés après cet échec. */
  recordFailure(id: string): Promise<number>;
  remove(id: string): Promise<void>;
}

export interface ActiveToken {
  id: string;
  hash: string;
  attempts: number;
  createdAt?: Date;
}

export class MongoVerificationTokenRepository implements VerificationTokenRepository {
  replace: VerificationTokenRepository["replace"] = async ({ email, type, hash, expiresAt }) => {
    await Token.deleteMany({ email, type });
    await Token.create({ email, type, hash, expiresAt });
  };

  findValid: VerificationTokenRepository["findValid"] = async ({ email, type, hash }) => {
    const doc = await Token.findOne({ email, type, hash, expiresAt: { $gt: new Date() } }).select("_id").lean<{ _id: unknown }>().exec();
    return doc ? { id: String(doc._id) } : null;
  };

  findActive: VerificationTokenRepository["findActive"] = async ({ email, type }) => {
    const doc = await Token.findOne({ email, type, expiresAt: { $gt: new Date() } })
      .lean<{ _id: unknown; hash: string; attempts?: number; createdAt?: Date }>()
      .exec();
    return doc ? { id: String(doc._id), hash: doc.hash, attempts: doc.attempts ?? 0, createdAt: doc.createdAt } : null;
  };

  recordFailure: VerificationTokenRepository["recordFailure"] = async (id) => {
    const doc = await Token.findByIdAndUpdate(id, { $inc: { attempts: 1 } }, { new: true }).lean<{ attempts?: number }>().exec();
    return doc?.attempts ?? Number.MAX_SAFE_INTEGER;
  };

  remove: VerificationTokenRepository["remove"] = async (id) => {
    await Token.deleteOne({ _id: id });
  };
}
