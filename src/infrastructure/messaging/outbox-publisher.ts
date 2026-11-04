import type { DomainEventName } from "../../shared/constants/index.js";
import type { EventPublisher } from "../../shared/ports/index.js";
import { logger } from "../logging/logger.js";
import { domainEventsQueued } from "../observability/metrics.js";
import { createEnvelope } from "./event-envelope.js";
import type { OutboxRepository } from "./outbox.repository.js";

const log = logger.child({ component: "outbox" });

/**
 * Publie un événement de domaine en l'inscrivant dans la boîte d'envoi (collection `outboxes`) ; c'est le relais
 * (`OutboxRelay`) qui l'envoie ensuite à RabbitMQ. Conséquence : une panne de RabbitMQ ne perd plus d'événement.
 *
 * Limite assumée : MongoDB en instance unique n'offre pas de transaction, donc l'écriture de l'événement suit celle du compte
 * sans être atomique avec elle. Un plantage exactement entre les deux perdrait l'événement (fenêtre de quelques millisecondes,
 * contre « toute la durée d'une panne du bus » auparavant). Avec un replica set, on pourrait englober les deux écritures dans
 * une transaction.
 *
 * Sans RABBITMQ_URL, il n'y a aucun consommateur : l'événement est seulement journalisé (la boîte ne s'accumule pas).
 */
export class OutboxEventPublisher implements EventPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly options: { enabled: boolean },
  ) {}

  async publish(name: DomainEventName, payload: Record<string, unknown>): Promise<void> {
    const envelope = createEnvelope(name, payload);
    // Pas de données personnelles (e-mail, nom) dans les journaux : seulement l'identifiant du sujet.
    log.info({ event: name, eventId: envelope.id, subject: payload.id, queued: this.options.enabled }, "événement publié");
    if (!this.options.enabled) return;
    try {
      await this.outbox.add(envelope);
      domainEventsQueued.inc({ event: name });
    } catch (err) {
      // L'opération métier a déjà réussi : on ne la fait pas échouer pour un événement, mais on le signale fortement.
      log.error({ err, event: name, eventId: envelope.id }, "événement non enregistré dans la boîte d'envoi");
    }
  }
}
