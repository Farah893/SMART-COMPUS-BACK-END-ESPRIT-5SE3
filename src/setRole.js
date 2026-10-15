import mongoose from "mongoose";
import { config } from "./config.js";
import { User } from "./models/index.js";
import { ROLES } from "./utils/validation.js";

/**
 * Change le rôle d'un compte existant, hors interface (dépannage / premier administrateur).
 * Usage : npm run set-role -- adresse@gmail.com admin
 */
const [email, role] = process.argv.slice(2);
if (!email || !ROLES.includes(role)) {
  console.error(`Usage : npm run set-role -- <e-mail> <${ROLES.join("|")}>`);
  process.exit(1);
}

await mongoose.connect(config.mongoUri);
const user = await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { role }, { new: true });
await mongoose.disconnect();
if (!user) {
  console.error(`Aucun compte pour ${email}`);
  process.exit(1);
}
console.info(`${user._id} · ${user.email} : rôle = ${user.role}`);
