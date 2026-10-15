import mongoose from "mongoose";

const { Schema } = mongoose;

/** Compte utilisateur. `_id` = matricule (ex. ETU-2026-0001) ; exposé sous le nom `id`. */
const userSchema = new Schema(
  {
    _id: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: String,
    role: { type: String, enum: ["student", "teacher", "admin"], required: true, index: true },
    status: { type: String, enum: ["active", "inactive", "suspended"], default: "active", index: true },
    failedAttempts: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    avatarUrl: String,
    mustChangePassword: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: false,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        ret.createdAt = ret.createdAt?.toISOString?.() ?? ret.createdAt;
        ret.lastLoginAt = ret.lastLoginAt ? new Date(ret.lastLoginAt).toISOString() : null;
        if (!ret.mustChangePassword) delete ret.mustChangePassword;
        for (const k of ["_id", "__v", "updatedAt", "passwordHash", "emailVerified"]) delete ret[k];
        return ret;
      },
    },
  },
);
userSchema.index({ firstName: "text", lastName: "text", email: "text" });

const loginEventSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    userName: String,
    date: { type: Date, default: Date.now, index: true },
    ip: String,
    device: String,
    success: Boolean,
  },
  {
    toJSON: {
      transform: (_d, ret) => ({
        id: String(ret._id), userId: ret.userId, userName: ret.userName,
        date: new Date(ret.date).toISOString(), ip: ret.ip, device: ret.device, success: ret.success,
      }),
    },
  },
);

const permissionSchema = new Schema({
  role: { type: String, enum: ["student", "teacher", "admin"], required: true },
  key: { type: String, required: true },
  granted: { type: Boolean, default: false },
});
permissionSchema.index({ role: 1, key: 1 }, { unique: true });

/** Jetons à usage unique (code de vérification d'e-mail, réinitialisation de mot de passe), expirés par TTL. */
const tokenSchema = new Schema({
  email: { type: String, required: true, index: true },
  type: { type: String, enum: ["verify-email", "reset-password"], required: true },
  hash: { type: String, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });

export const User = mongoose.model("User", userSchema);
export const LoginEvent = mongoose.model("LoginEvent", loginEventSchema);
export const Permission = mongoose.model("Permission", permissionSchema);
export const Token = mongoose.model("Token", tokenSchema);
export const Counter = mongoose.model("Counter", counterSchema);
