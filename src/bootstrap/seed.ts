import { ensureIndexes } from "../infrastructure/database/mongo.js";
import type { Container } from "../container.js";
import { logger } from "../infrastructure/logging/logger.js";

/** Idempotent : matrice de permissions par défaut + compte administrateur fixe (FIRST_ADMIN_*). */
export async function seed({ config, userRepository, userService, roleService, passwordHasher }: Container): Promise<void> {
  await ensureIndexes();
  await roleService.seedDefaultPermissions();
  const a = config.firstAdmin;
  // Garantit l'existence du compte administrateur fixe (admin@gmail.com par defaut),
  // meme si d'autres administrateurs existent deja dans la base.
  if (await userRepository.existsByEmailAndRole(a.email, "admin")) return;
  await userService.createAccount({
    firstName: a.firstName, lastName: a.lastName, email: a.email, role: "admin",
    passwordHash: await passwordHasher.hash(a.password), mustChangePassword: config.isProd,
  });
  logger.info({ email: a.email }, "administrateur fixe créé");
}
