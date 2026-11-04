import crypto, { type KeyObject } from "node:crypto";
import jwt, { type Algorithm, type JwtPayload, type SignOptions } from "jsonwebtoken";
import { config } from "../../config/index.js";
import type { Jwks, TokenClaims, TokenService } from "../../shared/ports/index.js";

export interface TokenServiceOptions {
  expiresIn: string;
  issuer: string;
  audience: string;
  /** Clé privée RSA (PEM) : active **RS256**. Seul le user-service la détient ; les autres services n'ont que la clé publique (JWKS). */
  privateKeyPem?: string;
  /** Ancienne clé publique (PEM), conservée le temps de la rotation : les jetons encore valides continuent d'être acceptés. */
  previousPublicKeyPem?: string;
  /** HS256 (secret partagé) : développement et tests uniquement, refusé en production. */
  secret?: string;
}

/** Empreinte de clé (RFC 7638) : identifiant `kid` stable, dérivé de la clé publique elle-même. */
function thumbprint(publicKey: KeyObject): string {
  const { e, kty, n } = publicKey.export({ format: "jwk" });
  return crypto.createHash("sha256").update(JSON.stringify({ e, kty, n })).digest("base64url");
}

const toClaims = (decoded: string | JwtPayload): TokenClaims => decoded as TokenClaims;

/**
 * Jeton signé : `sub`, `name`, `role` (contrat du front et des autres services) + `iss`, `aud`, `iat`, `exp`.
 * L'algorithme est **fixé** à la vérification (jamais lu dans le jeton) : pas d'attaque `alg: none`, ni de confusion
 * RS256 → HS256 (signer avec la clé publique, qui est publique, comme s'il s'agissait d'un secret).
 */
export function createJwtTokenService(o: TokenServiceOptions): TokenService {
  const base = { issuer: o.issuer, audience: o.audience };
  const signOptions = (algorithm: Algorithm): SignOptions => ({ ...base, algorithm, expiresIn: o.expiresIn as SignOptions["expiresIn"] });
  const payloadOf = (user: { _id: string; firstName: string; lastName: string; role: string }) => ({
    sub: user._id, name: `${user.firstName} ${user.lastName}`, role: user.role,
  });

  if (!o.privateKeyPem) {
    if (!o.secret) throw new Error("JWT : définir JWT_PRIVATE_KEY (RS256) ou, en développement, JWT_SECRET");
    const secret = o.secret;
    return {
      sign: (user) => jwt.sign(payloadOf(user), secret, signOptions("HS256")),
      verify: (token) => toClaims(jwt.verify(token, secret, { ...base, algorithms: ["HS256"] })),
      jwks: () => ({ keys: [] }), // un secret partagé ne se publie jamais
    };
  }

  const privateKey = crypto.createPrivateKey(o.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("JWT_PRIVATE_KEY doit être une clé RSA");
  if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("JWT_PRIVATE_KEY : clé RSA de 2048 bits minimum");
  const current = crypto.createPublicKey(privateKey);
  const keyring = new Map<string, KeyObject>([[thumbprint(current), current]]);
  const currentKid = thumbprint(current);
  if (o.previousPublicKeyPem) {
    const previous = crypto.createPublicKey(o.previousPublicKeyPem);
    keyring.set(thumbprint(previous), previous);
  }

  return {
    sign: (user) => jwt.sign(payloadOf(user), privateKey, { ...signOptions("RS256"), keyid: currentKid }),
    verify: (token) => {
      const kid = jwt.decode(token, { complete: true })?.header.kid;
      const key = kid ? keyring.get(kid) : undefined;
      if (!key) throw new Error("clé de signature inconnue");
      return toClaims(jwt.verify(token, key, { ...base, algorithms: ["RS256"] }));
    },
    jwks: (): Jwks => ({
      keys: [...keyring].map(([kid, key]) => ({ ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" })),
    }),
  };
}

export const jwtTokenService: TokenService = createJwtTokenService({
  expiresIn: config.jwtExpiresIn,
  issuer: config.jwt.issuer,
  audience: config.jwt.audience,
  privateKeyPem: config.jwt.privateKey,
  previousPublicKeyPem: config.jwt.previousPublicKey,
  secret: config.jwtSecret,
});
