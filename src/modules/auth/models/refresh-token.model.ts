import mongoose, { Schema } from "mongoose";

/**
 * Jeton de rafraîchissement : valeur aléatoire opaque, stockée HACHÉE (jamais en clair).
 * Tous les jetons issus d'une même connexion partagent un `familyId` : si l'un d'eux est rejoué, on révoque la famille.
 */
export interface RefreshTokenEntity {
  userId: string;
  familyId: string;
  hash: string;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
}

const refreshTokenSchema = new Schema<RefreshTokenEntity>({
  userId: { type: String, required: true, index: true },
  familyId: { type: String, required: true, index: true },
  hash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, expires: 0 }, // suppression automatique par MongoDB (TTL)
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
});

export const RefreshToken = mongoose.model<RefreshTokenEntity>("RefreshToken", refreshTokenSchema);
