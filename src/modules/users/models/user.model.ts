import mongoose, { Schema } from "mongoose";
import { ROLES, USER_STATUSES } from "../../../shared/constants/index.js";
import type { UserWithPassword } from "../types/user.types.js";

/** Détail de persistance uniquement : le contrat JSON est défini par le DTO de sortie (`user.dto.ts`). */
const userSchema = new Schema<UserWithPassword>(
  {
    _id: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: String,
    role: { type: String, enum: ROLES, required: true, index: true },
    status: { type: String, enum: USER_STATUSES, default: "active", index: true },
    failedAttempts: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    avatarUrl: String,
    mustChangePassword: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    tokensValidAfter: Date,
    lockedUntil: Date,
    verificationPending: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);
userSchema.index({ firstName: "text", lastName: "text", email: "text" });

export const UserModel = mongoose.model<UserWithPassword>("User", userSchema);

/** Séquences de matricules par rôle (incrément atomique). */
interface CounterEntity {
  _id: string;
  seq: number;
}
const counterSchema = new Schema<CounterEntity>({ _id: String, seq: { type: Number, default: 0 } });
export const CounterModel = mongoose.model<CounterEntity>("Counter", counterSchema);
