import mongoose from "mongoose";
import { config } from "./config.js";
import { User } from "./models/index.js";
import { createAccount } from "./services/accounts.js";
import { seedPermissions } from "./services/permissions.js";
import { hashPassword } from "./utils/security.js";

/** Idempotent : matrice de permissions par défaut + premier administrateur s'il n'existe aucun admin. */
export async function seed() {
  await seedPermissions();
  if (await User.exists({ role: "admin" })) return;
  const a = config.firstAdmin;
  await createAccount({
    firstName: a.firstName, lastName: a.lastName, email: a.email, role: "admin",
    passwordHash: await hashPassword(a.password), mustChangePassword: config.isProd,
  });
  console.info(`[user-service] premier administrateur créé : ${a.email}`);
}

// Exécution directe : npm run seed
if (process.argv[1]?.endsWith("seed.js")) {
  await mongoose.connect(config.mongoUri);
  await seed();
  await mongoose.disconnect();
}
