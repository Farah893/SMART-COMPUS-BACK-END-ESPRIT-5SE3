import crypto from "node:crypto";

const pick = (chars: string): string => chars[crypto.randomInt(chars.length)]!;

/** 10 caractères sans lettres ambiguës, avec majuscule, minuscule et chiffre. */
export function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const chars = [pick(upper), pick(lower), pick(digits), ...Array.from({ length: 7 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export const randomToken = (): string => crypto.randomBytes(32).toString("hex");
export const randomCode = (): string => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
