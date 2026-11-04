import mongoose, { Schema } from "mongoose";

export interface LoginEventEntity {
  userId: string;
  userName?: string;
  date: Date;
  ip?: string;
  device?: string;
  success?: boolean;
  /** Date de purge automatique (TTL MongoDB). Absent sur les anciens enregistrements, qui restent. */
  expiresAt?: Date;
}

/** Événement lu en base (objet simple, `_id` généré par MongoDB). */
export interface LoginEventRecord extends LoginEventEntity {
  _id: unknown;
}

const loginEventSchema = new Schema<LoginEventEntity>({
  userId: { type: String, required: true, index: true },
  userName: String,
  date: { type: Date, default: Date.now, index: true },
  ip: String,
  device: String,
  success: Boolean,
  expiresAt: { type: Date, expires: 0 },
});

export const LoginEvent = mongoose.model<LoginEventEntity>("LoginEvent", loginEventSchema);
