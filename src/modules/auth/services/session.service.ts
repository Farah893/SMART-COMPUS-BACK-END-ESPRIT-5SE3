import { randomUUID } from "node:crypto";
import { unauthorized } from "../../../shared/errors/app-error.js";
import type { SessionStore } from "../../../shared/ports/index.js";
import { logger } from "../../../infrastructure/logging/logger.js";
import { randomToken, sha256 } from "../../../infrastructure/security/random.js";
import type { RefreshTokenRepository } from "../repositories/refresh-token.repository.js";

const log = logger.child({ component: "sessions" });
const DAY_MS = 86_400_000;

/**
 * Sessions longues : jetons de rafraîchissement à rotation.
 *  - chaque usage émet un NOUVEAU jeton et consomme l'ancien (usage unique) ;
 *  - rejouer un jeton déjà consommé signale un vol probable : toute la famille est révoquée ;
 *  - exception : dans une courte fenêtre de grâce (quelques secondes), un jeton consommé qui revient est traité comme une
 *    requête simultanée (deux onglets partageant les mêmes cookies), pas comme un vol : on émet un jeton de plus dans la même
 *    famille. Compromis assumé : un voleur qui rejouerait dans cette fenêtre ne serait pas détecté.
 * Le jeton d'accès (JWT) reste court et sans état ; ce service ne gère que la continuité de session.
 */
export class SessionService implements SessionStore {
  constructor(
    private readonly tokens: RefreshTokenRepository,
    private readonly options: { ttlDays: number; graceSeconds?: number },
  ) {}

  private async issue(userId: string, familyId: string): Promise<string> {
    const value = randomToken();
    await this.tokens.create({
      userId, familyId, hash: sha256(value), expiresAt: new Date(Date.now() + this.options.ttlDays * DAY_MS),
    });
    return value;
  }

  /** Nouvelle session (une connexion = une nouvelle famille). */
  open(userId: string): Promise<string> {
    return this.issue(userId, randomUUID());
  }

  /** Échange un jeton valide contre le suivant. Toute anomalie → 401 générique (aucune fuite sur la cause). */
  async rotate(refreshToken: string): Promise<{ userId: string; familyId: string; refreshToken: string }> {
    const hash = sha256(refreshToken);
    const claimed = await this.tokens.claim(hash);
    if (!claimed) {
      const known = await this.tokens.findByHash(hash);
      const graceMs = (this.options.graceSeconds ?? 0) * 1000;
      if (known?.usedAt && !known.revokedAt && known.expiresAt > new Date() && Date.now() - new Date(known.usedAt).getTime() < graceMs) {
        return { userId: known.userId, familyId: known.familyId, refreshToken: await this.issue(known.userId, known.familyId) };
      }
      if (known?.usedAt) {
        await this.tokens.revokeFamily(known.familyId);
        log.warn({ userId: known.userId, familyId: known.familyId }, "jeton de rafraîchissement rejoué : famille révoquée");
      }
      throw unauthorized("Session invalide ou expirée", { code: "INVALID_REFRESH_TOKEN" });
    }
    return { userId: claimed.userId, familyId: claimed.familyId, refreshToken: await this.issue(claimed.userId, claimed.familyId) };
  }

  /** Termine la session portant ce jeton (idempotent : un jeton inconnu est ignoré). */
  async close(refreshToken: string): Promise<void> {
    const known = await this.tokens.findByHash(sha256(refreshToken));
    if (known) await this.tokens.revokeFamily(known.familyId);
  }

  closeFamily(familyId: string): Promise<void> {
    return this.tokens.revokeFamily(familyId);
  }

  /** Termine toutes les sessions d'un compte. */
  closeAll(userId: string): Promise<void> {
    return this.tokens.revokeAllForUser(userId);
  }
}
