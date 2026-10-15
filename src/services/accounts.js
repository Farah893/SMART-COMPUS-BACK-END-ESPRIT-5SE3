import { Counter, LoginEvent, User } from "../models/index.js";
import { config } from "../config.js";

const PREFIX = { student: "ETU", teacher: "ENS", admin: "ADM" };

/** Matricule : ETU-2026-0001 (séquence par rôle, atomique). */
export async function nextId(role) {
  const c = await Counter.findOneAndUpdate({ _id: `user-${role}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${PREFIX[role]}-${new Date().getFullYear()}-${String(c.seq).padStart(4, "0")}`;
}

export const fullName = (u) => `${u.firstName} ${u.lastName}`;

export async function createAccount({ firstName, lastName, email, role, passwordHash, mustChangePassword = false }) {
  return User.create({
    _id: await nextId(role), firstName, lastName, email, role, passwordHash, mustChangePassword,
  });
}

function deviceOf(ua = "") {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navigateur";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Inconnu";
  return `${browser} · ${os}`;
}

export const logLogin = (user, req, success) =>
  LoginEvent.create({
    userId: user._id, userName: fullName(user), success,
    ip: (req.ip ?? "").replace("::ffff:", ""), device: deviceOf(req.get("user-agent")),
  });

export const userStats = async () => {
  const rows = await User.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const active = by.active ?? 0, inactive = by.inactive ?? 0, suspended = by.suspended ?? 0;
  return { total: active + inactive + suspended, active, inactive, suspended };
};

export const MAX_ATTEMPTS = config.maxAttempts;
