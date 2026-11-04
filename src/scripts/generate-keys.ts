import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Génère une paire de clés RSA 3072 bits pour signer les jetons (RS256).
 *   npm run keys:generate            -> keys/jwt-private.pem + keys/jwt-public.pem
 * La clé privée ne quitte JAMAIS le user-service et ne va JAMAIS dans git (le dossier keys/ est ignoré).
 * Les autres services récupèrent la clé publique via GET /.well-known/jwks.json.
 */
const dir = join(process.cwd(), "keys");
const privatePath = join(dir, "jwt-private.pem");
if (existsSync(privatePath) && !process.argv.includes("--force")) {
  console.error(`${privatePath} existe déjà : rien n'a été écrasé (--force pour remplacer ; les jetons déjà émis deviendraient invalides).`);
  process.exit(1);
}
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(join(dir, "jwt-public.pem"), publicKey);
try {
  chmodSync(privatePath, 0o600);
} catch {
  /* Windows : les droits POSIX ne s'appliquent pas */
}
console.info("Clés générées dans keys/ :");
console.info("  keys/jwt-private.pem  (SECRET)  -> JWT_PRIVATE_KEY_FILE=keys/jwt-private.pem");
console.info("  keys/jwt-public.pem   (publique, pour information : le service la publie lui-même en JWKS)");
