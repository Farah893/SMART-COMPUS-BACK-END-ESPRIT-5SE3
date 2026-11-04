import { ROLES, type Role } from "../shared/constants/index.js";
import { config } from "../config/index.js";
import { connectDatabase, disconnectDatabase } from "../infrastructure/database/mongo.js";
import { MongoUserRepository } from "../modules/users/repositories/user.repository.js";

/**
 * Change le rôle d'un compte existant, hors interface (dépannage / premier administrateur).
 * Usage : npm run set-role -- adresse@gmail.com admin
 */
const [email, role] = process.argv.slice(2);
if (!email || !role || !(ROLES as readonly string[]).includes(role)) {
  console.error(`Usage : npm run set-role -- <e-mail> <${ROLES.join("|")}>`);
  process.exit(1);
}

await connectDatabase(config.mongoUri);
const user = await new MongoUserRepository().setRoleByEmail(email.trim().toLowerCase(), role as Role);
await disconnectDatabase();
if (!user) {
  console.error(`Aucun compte pour ${email}`);
  process.exit(1);
}
console.info(`${user._id} · ${user.email} : rôle = ${user.role}`);
