import type { DomainEventName } from "../constants/index.js";

/**
 * Ports : ce dont la couche métier a besoin, sans savoir comment c'est fait (bcrypt, JWT, SMTP, RabbitMQ…).
 * Les adaptateurs vivent dans `infrastructure/` ; les tests peuvent fournir des doublures.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface TokenClaims {
  sub: string;
  name: string;
  role: string;
  /** Date d'émission (secondes) : sert à refuser les jetons émis avant une révocation. */
  iat?: number;
}

/** Ce dont le service des comptes a besoin des sessions : pouvoir les terminer toutes. */
export interface SessionStore {
  closeAll(userId: string): Promise<void>;
}

/** Clés publiques de vérification (JSON Web Key Set, RFC 7517) : ce que les autres services téléchargent pour vérifier les jetons. */
export interface Jwks {
  keys: Array<Record<string, unknown>>;
}

export interface TokenService {
  /** Clés publiques à publier (vide en HS256 : un secret partagé ne se publie jamais). */
  jwks(): Jwks;
  sign(user: { _id: string; firstName: string; lastName: string; role: string }): string;
  verify(token: string): TokenClaims;
}

export interface MailRecipient {
  email: string;
  firstName: string;
  role: string;
}

export interface MailService {
  sendTemporaryPassword(user: MailRecipient, temporary: string): Promise<void>;
  sendVerificationCode(email: string, code: string): Promise<void>;
  sendResetLink(email: string, token: string): Promise<void>;
}

export interface EventPublisher {
  /** Enregistre l'événement pour publication (au moins une fois). Ne fait jamais échouer l'opération métier appelante. */
  publish(name: DomainEventName, payload: Record<string, unknown>): Promise<void>;
}
