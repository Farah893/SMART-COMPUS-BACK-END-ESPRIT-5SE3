# RabbitMQ, événements de domaine et outbox : explication technique

Ce document explique **pourquoi** le user-service publie des événements, **pourquoi RabbitMQ**, et **exactement** ce que fait chaque étape du mécanisme (boîte d'envoi, relais, confirmations, reconnexion). Tout ce qui est décrit ici a été vérifié en conditions réelles (voir `docs/TESTS-ET-VERIFICATION.md`, §7).

---

## 1. Le problème que ça résout

SmartCampus est composé de plusieurs microservices (`user-service`, `academic`, `resources`, `housing`, `student-life`, `library`). Chacun possède **sa propre base**. Quand un compte est créé dans le user-service, d'autres services ont besoin de le savoir : la bibliothèque veut créer une fiche d'emprunteur, la vie étudiante veut proposer des clubs, etc.

Deux façons de le leur dire :

| Approche | Fonctionnement | Défaut |
|---|---|---|
| **Appel HTTP synchrone** | Le user-service appelle `POST /borrowers` de la bibliothèque après avoir créé le compte | **Couplage temporel** : si la bibliothèque est en panne, la création du compte échoue ou l'information est perdue. Chaque nouveau service intéressé oblige à modifier le user-service. |
| **Événement asynchrone** | Le user-service publie « un compte a été créé » ; ceux que ça intéresse s'abonnent | Il faut un courtier de messages et gérer la fiabilité de l'envoi. |

On a choisi l'événement. Le user-service **ne connaît pas ses consommateurs** : ajouter un service intéressé ne demande aucune modification ici.

### Pourquoi RabbitMQ (et pas autre chose)

| Option | Pourquoi pas / pourquoi oui |
|---|---|
| Appels HTTP directs | Couplage temporel, voir ci-dessus. |
| **RabbitMQ** | Courtier de messages classique : routage flexible (exchange *topic*), accusés de réception, messages persistants, files durables par consommateur, interface d'administration. Simple à exploiter pour quelques événements par minute. **Retenu.** |
| Kafka | Journal distribué avec relecture de l'historique. Très puissant, mais lourd à exploiter, surdimensionné pour des événements de gestion de comptes. À reconsidérer si un service a besoin de **rejouer** tout l'historique. |
| Redis Pub/Sub | Pas de persistance : un consommateur absent rate le message. Inacceptable ici. |
| File dans MongoDB seule | Possible, mais on réinventerait le routage, les accusés et la distribution à plusieurs consommateurs. (On utilise tout de même MongoDB pour la **boîte d'envoi**, voir §4.) |

Contrepartie assumée : une brique d'infrastructure de plus à exploiter. C'est pourquoi RabbitMQ est **optionnel** (`RABBITMQ_URL` vide = événements seulement journalisés).

---

## 2. Vocabulaire RabbitMQ (AMQP 0-9-1)

```
 Producteur ──► EXCHANGE ──(binding + routing key)──► QUEUE ──► Consommateur
 (user-service)  "smartcampus.events"                 (une par service intéressé)
                  type: topic
```

- **Exchange** : point d'entrée où l'on publie. Il ne stocke rien : il **route**. Ici `smartcampus.events`, de type **topic**, **durable** (survit à un redémarrage du courtier).
- **Routing key** : étiquette portée par chaque message. Ici `user.UtilisateurCréé` ou `user.RôleModifié`.
- **Queue** : file qui **stocke** les messages jusqu'à ce qu'un consommateur les traite. **Chaque service consommateur a sa propre file**, ce qui permet à la bibliothèque et à la vie étudiante de recevoir chacun **une copie** du même événement (fan-out).
- **Binding** : règle qui relie une file à l'exchange avec un motif de clé. Dans un exchange *topic* : `*` remplace un mot, `#` remplace zéro ou plusieurs mots. Exemples : `user.UtilisateurCréé` (exact), `user.#` (tous les événements du user-service).
- **Persistance** : pour qu'un message survive à un redémarrage du courtier, il faut **les deux** : message `persistent` **et** file `durable`.
- **Accusé du consommateur (ack)** : le consommateur confirme qu'il a traité le message ; sans ack, RabbitMQ le remet.
- **Publisher confirm** : l'inverse, côté producteur. Le courtier confirme (« ack ») qu'il a bien **pris en charge** (et, pour une file durable, écrit sur disque) le message. Sans cela, `publish()` ne garantit rien : le message peut être perdu sans erreur.

---

## 3. Le contrat des messages

### 3.1 Événements publiés

| Routing key | Quand | `payload` |
|---|---|---|
| `user.UtilisateurCréé` | Inscription publique **ou** création par un administrateur | `{ id, email, role, name, createdBy? }` (`createdBy` seulement si créé par un admin) |
| `user.RôleModifié` | Un admin change le rôle d'un compte (jamais si le rôle est identique) | `{ id, email, previous, role, changedBy }` |

### 3.2 Enveloppe (corps JSON du message)

```json
{
  "id": "7abd1f89-8020-4ab1-a4c3-30915c1a65ba",
  "name": "UtilisateurCréé",
  "version": 1,
  "occurredAt": "2026-11-02T21:20:11.532Z",
  "payload": { "id": "ENS-2026-0003", "email": "alpha@smartcampus.tn", "role": "teacher", "name": "E2E alpha", "createdBy": "ADM-2026-0001" }
}
```

| Champ | Rôle |
|---|---|
| `name`, `occurredAt`, `payload` | Contrat **historique**, inchangé : les consommateurs existants continuent de fonctionner. |
| `id` | Identifiant unique de l'événement (UUID). Sert à la **déduplication** (voir §6). |
| `version` | Version du **schéma d'enveloppe**. À incrémenter en cas de changement incompatible. |

### 3.3 Propriétés AMQP (en plus du corps)

| Propriété | Valeur |
|---|---|
| `messageId` | = `id` (permet de dédupliquer **sans parser le corps**) |
| `type` | = `name` |
| `contentType` | `application/json` |
| `deliveryMode` | `2` (persistant) |
| `timestamp` | `occurredAt` en secondes |
| `headers["schema-version"]` | = `version` |

Fichier : `src/infrastructure/messaging/event-envelope.ts`.

---

## 4. Le vrai problème : l'écriture double (« dual write »)

Quand on crée un compte, il faut faire **deux** choses : (1) écrire le compte dans MongoDB, (2) publier l'événement dans RabbitMQ. Ce sont deux systèmes différents, **sans transaction commune**. Que se passe-t-il si ça tombe en panne entre les deux ?

```
 Version naïve                           Résultat en cas de panne
 ─────────────                           ────────────────────────
 1. INSERT compte        ✔               RabbitMQ arrêté à l'étape 2
 2. publish(événement)   ✘  ──────────►  → compte créé, événement PERDU pour toujours
                                           les autres services ne sauront jamais que ce compte existe
```

Inverser l'ordre est pire (événement publié pour un compte qui n'existe pas). C'était le comportement d'origine du service : l'événement n'était publié que si le canal RabbitMQ était connecté à cet instant, et la connexion ne se rétablissait **jamais** après une coupure.

### La solution : le patron *Transactional Outbox*

On sépare **décider** de publier et **réaliser** la publication :

```
        ┌──────────────── user-service ────────────────┐
 HTTP   │                                              │
 POST ─►│ 1. UserService écrit le compte    ─► MongoDB │  (collection users)
 /users │ 2. UserService écrit l'événement  ─► MongoDB │  (collection outboxes, status=pending)
        │ 3. répond 201 au client                      │
        │                                              │
        │   (en arrière-plan, boucle toutes les ~1 s)  │
        │ 4. OutboxRelay lit les « pending »           │
        │ 5. le publie sur RabbitMQ ──► attend l'ack   │──► exchange ──► files ──► consommateurs
        │ 6. marque « published » (+ TTL de rétention) │
        └──────────────────────────────────────────────┘
```

Garanties obtenues :
- La requête du client **ne dépend plus de RabbitMQ** : si le courtier est arrêté, `POST /users` répond quand même `201`.
- L'événement est **durable dès l'étape 2** (stocké en base). Une panne de RabbitMQ retarde la livraison mais ne la perd pas.
- Livraison **« au moins une fois »** (*at-least-once*) : jamais perdue, mais **possiblement en double** (voir §6).

### Limite assumée (à connaître, à pouvoir expliquer)

Les étapes 1 et 2 sont **deux écritures MongoDB successives, pas une transaction** : MongoDB en instance unique ne supporte pas les transactions multi-documents (il faut un *replica set*). Un plantage du processus **exactement entre** les étapes 1 et 2 perdrait l'événement. La fenêtre est de quelques millisecondes, contre « toute la durée d'une panne du courtier » avant. Pour la supprimer : déployer MongoDB en replica set et englober les deux écritures dans une transaction (ou utiliser les *change streams*).

Autre choix assumé : si l'écriture dans la boîte d'envoi échoue (base indisponible à cet instant), l'opération métier **n'est pas annulée** (le compte existe déjà) ; l'erreur est journalisée au niveau `error`.

---

## 5. Le fonctionnement détaillé, composant par composant

### 5.1 `OutboxEventPublisher` — `src/infrastructure/messaging/outbox-publisher.ts`
C'est ce que les services métier appellent (`await this.events.publish(nom, payload)`, via le port `EventPublisher`).
1. Construit l'enveloppe (`createEnvelope`) : génère l'UUID, la date, `version: 1`.
2. Journalise l'événement (toujours).
3. Si `RABBITMQ_URL` est vide → **s'arrête là** (aucun consommateur : la boîte ne doit pas grossir indéfiniment).
4. Sinon `outbox.add(envelope)` → insère un document `status: "pending"`.
5. Incrémente la métrique `domain_events_queued_total{event}`.

### 5.2 Collection `outboxes` — `outbox.model.ts`

| Champ | Rôle |
|---|---|
| `eventId` (unique) | UUID de l'enveloppe |
| `name`, `version`, `occurredAt`, `payload` | contenu de l'événement |
| `status` | `pending` → `published` |
| `attempts` | nombre de tentatives de publication (incrémenté **à la réservation**) |
| `nextAttemptAt` | pas de nouvelle tentative avant cette date (backoff) |
| `lockedUntil` | **bail** : l'événement est « réservé » jusqu'à cette date |
| `lastError` | dernier message d'erreur (diagnostic) |
| `publishedAt`, `expiresAt` | posés à la publication ; `expiresAt` est un **index TTL** : MongoDB supprime l'événement après la rétention (7 jours par défaut) |

### 5.3 `OutboxRelay` — `outbox-relay.ts` (le cœur)
Une boucle `setTimeout` auto-replanifiée (`OUTBOX_POLL_MS`, 1 s). Chaque cycle (`runOnce`) :

```
runOnce()
 ├─ le transport est-il connecté ?
 │    non ─► est-ce trop tôt pour réessayer (backoff de reconnexion) ? oui → on sort
 │           transport.connect()
 │           échec ? → délai de reconnexion ×2 (1 s, 2 s, 4 s… plafonné à 60 s) → on sort SANS RIEN RÉSERVER
 │           succès ? → délai remis à 0
 ├─ lot = outbox.claimBatch(50, bail 30 s)          ← réservation atomique
 └─ pour chaque événement du lot, dans l'ordre :
       transport.publish(enveloppe)   ← attend l'ACK du courtier
         ├─ succès → markPublished (status=published, expiresAt = maintenant + rétention)
         └─ échec  → markFailed (nextAttemptAt = maintenant + min(60 s, 1 s × 2^tentatives))
                     et on ARRÊTE le lot (on conserve l'ordre : les suivants attendent)
```

Pourquoi chaque détail existe :

- **Réservation atomique** (`claimBatch`) : un `findOneAndUpdate` conditionnel
  `{status:"pending", nextAttemptAt ≤ now, (lockedUntil null OU < now)}` → `{lockedUntil: now+bail, $inc attempts}`.
  Si **deux instances** du service tournent, MongoDB garantit qu'**une seule** obtient chaque document. Pas de double envoi concurrent.
- **Bail (lease)** : si une instance plante *après* avoir réservé mais *avant* d'avoir publié, l'événement ne reste pas bloqué : une fois `lockedUntil` dépassé, un autre cycle (ou une autre instance) le reprend. Sans bail, un crash laisserait l'événement « réservé » à jamais.
- **Rien n'est réservé si le bus est absent** : sinon `attempts` grimperait pendant la panne et le backoff s'emballerait pour rien.
- **Backoff exponentiel** : en cas de refus, on ne marteille pas le courtier ; le délai double jusqu'au plafond.
- **Arrêt du lot au premier échec** : conserve l'ordre de publication pour une même instance.
- **`stop()`** : positionne un drapeau, annule la minuterie et **attend la fin du cycle en cours** (aucun événement abandonné à mi-publication). Appelé à l'arrêt du serveur, avant la fermeture de RabbitMQ puis de MongoDB.
- Le relais est démarré dans `server.ts` **seulement** (jamais dans `createApp`) : les tests n'ont donc aucune minuterie en arrière-plan.

### 5.4 `RabbitEventBus` — `event-bus.ts` (le transport)
- `connect()` : `amqp.connect(url)` puis `createConfirmChannel()` (canal **à confirmations**), puis `assertExchange("smartcampus.events", "topic", {durable:true})`. Idempotent (rien si déjà connecté).
- Écouteurs **`error`** sur la connexion et le canal : sans eux, une coupure réseau lèverait un événement `error` non géré qui **tuerait le processus Node**. Sur `close`, le canal est remis à `null` ⇒ `isConnected()` redevient faux ⇒ **c'est le relais qui reconnecte** (c'est la correction du défaut d'origine : « ne se reconnecte jamais »).
- `publish(enveloppe)` : `channel.publish(exchange, "user.<nom>", Buffer, {persistent:true, messageId, type, …}, callback)`. La promesse se **résout sur ack** et **se rejette sur nack ou erreur**. C'est ce qui permet au relais de ne marquer « publié » qu'après confirmation réelle du courtier.
- `status()` : `up | down | disabled`, utilisé par `/ready`.

### 5.5 Câblage — `src/container.ts` et `src/server.ts`
```
RabbitEventBus (transport) ◄── OutboxRelay ──► MongoOutboxRepository ◄── OutboxEventPublisher ◄── UserService / AuthService
```
`server.ts` : `eventBus.connect()` (un échec au démarrage n'est **pas** fatal), puis `outboxRelay.start()` si `RABBITMQ_URL` est défini.
Arrêt : `/ready`→503, attente du drainage, `server.close()`, **`outboxRelay.stop()`**, **`eventBus.close()`**, **`disconnectDatabase()`** — dans cet ordre, car le relais a besoin de Mongo et du bus pour finir son cycle.

---

## 6. Livraison « au moins une fois » et idempotence des consommateurs

Il y a un cas où un événement est livré **deux fois** : le relais publie, RabbitMQ répond ack, puis le processus plante **avant** `markPublished`. Au redémarrage, l'événement est toujours `pending` et repart.

Ce n'est pas un bug, c'est le compromis : on préfère un doublon à une perte. **Le consommateur doit donc être idempotent** : traiter deux fois le même événement doit donner le même résultat. Le moyen standard : mémoriser les `messageId` déjà traités (ou rendre l'opération naturellement idempotente, ex. « créer la fiche si elle n'existe pas »).

> **Ordre** : à l'intérieur d'une même instance, les événements partent dans l'ordre de `occurredAt`. Avec plusieurs instances du user-service, **aucun ordre global n'est garanti** entre instances. Les consommateurs ne doivent pas en dépendre (ex. utiliser `occurredAt` pour ignorer un événement plus ancien que l'état connu).

### Exemple de consommateur (à copier dans un autre service)

```js
import amqp from "amqplib";

const conn = await amqp.connect(process.env.RABBITMQ_URL);
const ch = await conn.createChannel();
await ch.assertExchange("smartcampus.events", "topic", { durable: true });

// UNE file par service consommateur, durable : elle accumule les messages pendant que le service est arrêté.
await ch.assertQueue("library.user-events", { durable: true });
await ch.bindQueue("library.user-events", "smartcampus.events", "user.UtilisateurCréé");
await ch.prefetch(10); // au plus 10 messages non acquittés à la fois

const seen = new Set(); // en vrai : une collection avec index unique sur messageId

await ch.consume("library.user-events", async (msg) => {
  if (!msg) return;
  try {
    if (!seen.has(msg.properties.messageId)) {          // déduplication
      const event = JSON.parse(msg.content.toString());
      await createBorrowerCard(event.payload);          // traitement idempotent
      seen.add(msg.properties.messageId);
    }
    ch.ack(msg);                                         // accusé : RabbitMQ peut oublier le message
  } catch (err) {
    ch.nack(msg, false, false);                          // refus sans remise : à envoyer vers une file « dead-letter »
  }
});
```
Recommandations côté consommateur : configurer une **dead-letter exchange** pour les messages refusés, ne jamais `ack` avant le traitement, et valider `version` (ignorer ou alerter si elle est inconnue).

---

## 7. Exploitation : que surveiller, que faire

| Signal | Où | Signification / action |
|---|---|---|
| `outbox_pending_events` | `GET /metrics` (jeton requis en production) | Doit retomber à 0. Une valeur qui **croît** = RabbitMQ injoignable, relais arrêté, ou événements refusés en boucle. **Alerte recommandée** : > 0 pendant plus de 5 min. |
| `domain_events_queued_total{event}` | `/metrics` | Débit d'événements créés. |
| `/ready` → `"status":"DEGRADED"`, `"rabbitmq":"down"` | HTTP | Le service fonctionne mais ne publie pas. Il ne faut **pas** le redémarrer : les événements sont en sécurité en base. |
| Logs `component":"outbox-relay"`, message « bus injoignable » | logs JSON | Montre le backoff (4 s, 8 s, 18 s, 32 s, 60 s…). |
| Logs « publication en échec, nouvelle tentative planifiée » | logs | Nack du courtier ; contient `eventId`, `attempts`, `retryAt`. |
| Collection `outboxes` : `lastError`, `attempts` | MongoDB | Diagnostic d'un événement bloqué. |
| `domain_events_queued` vs `outbox_pending_events` | — | Le premier ne baisse jamais (compteur), le second doit baisser. |

Interface d'administration RabbitMQ (image `rabbitmq:*-management`) : http://localhost:15672 (identifiants par défaut `guest`/`guest`, **à changer** hors développement).

### Variables de configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `RABBITMQ_URL` | *(vide)* | Vide = pas de bus (journal seul, boîte non alimentée). Ex. `amqp://rabbitmq:5672` |
| `RABBITMQ_EXCHANGE` | `smartcampus.events` | Nom de l'exchange topic |
| `OUTBOX_POLL_MS` | `1000` | Période du relais |
| `OUTBOX_BATCH_SIZE` | `50` | Événements traités par cycle |
| `OUTBOX_LEASE_MS` | `30000` | Durée du bail (> durée max d'un cycle) |
| `OUTBOX_MAX_BACKOFF_MS` | `60000` | Plafond du backoff (reconnexion et nouvelle tentative) |
| `OUTBOX_RETENTION_DAYS` | `7` | Conservation des événements publiés avant suppression TTL |

---

## 8. Comment l'ajouter pour un nouvel événement (recette)

1. Ajouter le nom dans `DOMAIN_EVENTS` (`src/shared/constants/index.ts`).
2. Dans le service concerné : `await this.events.publish(DOMAIN_EVENTS.MON_EVENEMENT, { ...payload })` **après** la modification d'état réussie.
3. Documenter le `payload` dans le tableau du §3.1.
4. Test unitaire : vérifier avec `recordingBus()` (`test/helpers/fakes.ts`) que l'événement est publié, et **qu'il ne l'est pas** dans les cas où il ne doit pas l'être (ex. rôle identique).
5. Prévenir les équipes consommatrices : le contrat (§3) fait foi. Un champ **ajouté** au `payload` est compatible ; un champ **retiré ou renommé** impose d'incrémenter `EVENT_SCHEMA_VERSION`.

---

## 9. Ce qui est testé (résumé)

- **Unitaire** (`test/outbox.test.ts`, doublures en mémoire) : enveloppe, ordre, reconnexion avec backoff, nack + nouvelle tentative, bail d'un relais planté, boîte non alimentée sans RabbitMQ, panne de la boîte sans échec métier, arrêt propre.
- **Réel** (Docker, RabbitMQ 4) : livraison avec bonnes propriétés AMQP, **panne du courtier** (l'API répond 201, `outbox_pending_events`=2, `/ready`=DEGRADED), **redémarrage** (reconnexion automatique, livraison des 2 événements dans l'ordre, `outbox_pending_events`=0).
