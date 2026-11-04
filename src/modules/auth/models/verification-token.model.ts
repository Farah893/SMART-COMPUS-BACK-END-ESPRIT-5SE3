import mongoose, { Schema } from "mongoose";
import { TOKEN_TYPES, type TokenType } from "../../../shared/constants/index.js";

export interface TokenEntity {
  email: string;
  type: TokenType;
  hash: string;
  expiresAt: Date;
  /** Essais ratés sur ce code : au-delà du seuil, il est détruit (un code à 6 chiffres ne se devine pas à la chaîne). */
  attempts?: number;
  createdAt?: Date;
}

/** Jetons à usage unique (code de vérification d'e-mail, réinitialisation de mot de passe), expirés par TTL. */
const tokenSchema = new Schema<TokenEntity>(
  {
    email: { type: String, required: true, index: true },
    type: { type: String, enum: Object.values(TOKEN_TYPES), required: true },
    hash: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Token = mongoose.model<TokenEntity>("Token", tokenSchema);
