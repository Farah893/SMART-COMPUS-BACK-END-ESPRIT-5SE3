import { RefreshToken, type RefreshTokenEntity } from "../models/refresh-token.model.js";

export interface RefreshTokenRepository {
  create(token: RefreshTokenEntity): Promise<void>;
  findByHash(hash: string): Promise<RefreshTokenEntity | null>;
  /**
   * Consomme le jeton de façon ATOMIQUE : un seul appel concurrent peut réussir.
   * Renvoie null si le jeton est inconnu, expiré, déjà utilisé ou révoqué.
   */
  claim(hash: string): Promise<RefreshTokenEntity | null>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class MongoRefreshTokenRepository implements RefreshTokenRepository {
  create: RefreshTokenRepository["create"] = async (token) => {
    await RefreshToken.create(token);
  };

  findByHash: RefreshTokenRepository["findByHash"] = (hash) => RefreshToken.findOne({ hash }).lean<RefreshTokenEntity>().exec();

  claim: RefreshTokenRepository["claim"] = (hash) =>
    RefreshToken.findOneAndUpdate(
      { hash, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
      { usedAt: new Date() },
      { new: true },
    )
      .lean<RefreshTokenEntity>()
      .exec();

  // On garde les documents (revokedAt) plutôt que de les supprimer : un jeton révoqué rejoué reste reconnaissable.
  revokeFamily: RefreshTokenRepository["revokeFamily"] = async (familyId) => {
    await RefreshToken.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date() });
  };

  revokeAllForUser: RefreshTokenRepository["revokeAllForUser"] = async (userId) => {
    await RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
  };
}
