import { randomUUID } from "node:crypto";
import type { DomainEventName } from "../../shared/constants/index.js";

/** Version du schéma d'enveloppe. À incrémenter si la forme change de façon incompatible. */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * Message publié sur le bus. Contrat avec les autres services :
 *  - `name`, `occurredAt`, `payload` : inchangés depuis la première version ;
 *  - `id` : identifiant unique de l'événement (= `messageId` AMQP) pour que les consommateurs dédupliquent
 *    (la livraison est « au moins une fois ») ;
 *  - `version` : version du schéma de l'enveloppe.
 * Clé de routage : `user.<name>` (inchangée).
 */
export interface EventEnvelope {
  id: string;
  name: DomainEventName;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export const createEnvelope = (name: DomainEventName, payload: Record<string, unknown>, now = new Date()): EventEnvelope => ({
  id: randomUUID(),
  name,
  version: EVENT_SCHEMA_VERSION,
  occurredAt: now.toISOString(),
  payload,
});

export const routingKeyOf = (name: DomainEventName): string => `user.${name}`;
