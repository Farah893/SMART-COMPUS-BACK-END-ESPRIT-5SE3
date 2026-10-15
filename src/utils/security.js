import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export const hashPassword = (pw) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

/** Jeton signé : `sub`, `name`, `role` (contrat du front). */
export const signToken = (user) =>
  jwt.sign({ sub: user._id, name: `${user.firstName} ${user.lastName}`, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);

const pick = (chars) => chars[crypto.randomInt(chars.length)];

/** 10 caractères sans lettres ambiguës, avec majuscule, minuscule et chiffre. */
export function generateTemporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const chars = [pick(upper), pick(lower), pick(digits), ...Array.from({ length: 7 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export const randomToken = () => crypto.randomBytes(32).toString("hex");
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
