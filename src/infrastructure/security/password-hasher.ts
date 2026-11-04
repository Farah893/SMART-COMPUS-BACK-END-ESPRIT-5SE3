import bcrypt from "bcryptjs";
import { config } from "../../config/index.js";
import type { PasswordHasher } from "../../shared/ports/index.js";

export const bcryptPasswordHasher: PasswordHasher = {
  hash: (plain) => bcrypt.hash(plain, config.bcryptRounds),
  verify: (plain, hash) => bcrypt.compare(plain, hash),
};
