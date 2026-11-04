import crypto from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Génère une paire de clés RSA 3072 bits pour signer les jetons (RS256).
 *   npm run keys:generate            -> keys/jwt-private.pem + keys/jwt-public.pem
 *   npm run keys:generate -- --force -> remplace une paire existante (les jetons déjà émis deviennent invalides)
 * La clé privée ne quitte JAMAIS le user-service et ne va JAMAIS dans git (le dossier keys/ est ignoré).
 * Les autres services récupèrent la clé publique via GET /.well-known/jwks.json.
 * KEYS_DIR (facultatif) change le dossier de sortie.
 */
const dir = process.env.KEYS_DIR ?? join(process.cwd(), "keys");
const privatePath = join(dir, "jwt-private.pem");
const publicPath = join(dir, "jwt-public.pem");
const force = process.argv.includes("--force");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

mkdirSync(dir, { recursive: true });
try {
  // Création EXCLUSIVE (flag « wx ») : l'échec « le fichier existe déjà » et l'écriture sont UNE SEULE opération du système.
  // L'ancien code testait d'abord `existsSync`, puis écrivait : entre les deux, un autre processus pouvait créer ou remplacer
  // le fichier (condition de course « time-of-check / time-of-use »), et la clé aurait pu être écrite dans un fichier qu'il contrôle.
  // Les droits 0600 sont posés À LA CRÉATION : la clé n'est jamais, même un instant, lisible par d'autres utilisateurs.
  writeFileSync(privatePath, privateKey, { mode: 0o600, flag: force ? "w" : "wx" });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "EEXIST") {
    console.error(`${privatePath} existe déjà : rien n'a été écrasé (--force pour remplacer ; les jetons déjà émis deviendraient invalides).`);
    process.exit(1);
  }
  throw err;
}
if (force) {
  try {
    chmodSync(privatePath, 0o600); // fichier préexistant remplacé : on resserre ses droits
  } catch {
    /* Windows : les droits POSIX ne s'appliquent pas */
  }
}
writeFileSync(publicPath, publicKey); // clé publique : pas un secret

console.info("Clés générées dans keys/ :");
console.info("  keys/jwt-private.pem  (SECRET)  -> JWT_PRIVATE_KEY_FILE=keys/jwt-private.pem");
console.info("  keys/jwt-public.pem   (publique, pour information : le service la publie lui-même en JWKS)");
