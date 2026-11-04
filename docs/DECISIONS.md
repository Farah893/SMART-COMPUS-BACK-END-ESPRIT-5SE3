# Décisions d'architecture et de produit

## D1 — Qui crée les cours et les salles ? (validée)

**Contexte.** Les README des modules Académique et Ressources ne prévoyaient aucune route de création de cours (`POST /courses`) ni de salles (`POST /rooms`), aucune permission correspondante et aucun écran. Les cours et les salles n'existaient que dans les données fictives.

**Décision.** Le catalogue est géré par l'**administrateur** uniquement.

| Donnée | Créer / modifier / supprimer | Droit (matrice du user-service) |
|---|---|---|
| Cours (avec enseignant responsable) | Administrateur | `academic.manage` (nouveau) |
| Salles et équipements | Administrateur | `resources.manage` (précisé : « Gérer les salles, valider les réservations et la maintenance ») |
| Notes d'un cours | Enseignant **du cours**, ou administrateur | `academic.grades` |
| Réservation d'une salle | Enseignant, administrateur | `resources.book` |

Les droits sont des permissions de la matrice, modifiables par l'admin ; seuls les droits `users.*` de l'admin sont verrouillés.

**Conséquences.**

*user-service (fait).* Ajout de `academic.manage` à la matrice (accordé à l'admin uniquement, par défaut) ; libellé de `resources.manage` précisé. Au redémarrage, le seed insère la nouvelle permission sans écraser les choix déjà faits par l'admin.

*academic-service (à faire).*
- `POST /courses` · `PUT /courses/{id}` · `DELETE /courses/{id}` : admin. Corps : `{code, title, credits, capacity, teacherId, semester, ...}` ; 403 · 409 `COURSE_EXISTS` · 422.
- `teacherId` doit désigner un compte de rôle `teacher` (voir `GET /users`, réservé à l'admin, ou l'événement `UtilisateurCréé`).
- Suppression refusée (409) s'il existe des inscriptions validées.

*resource-service (à faire).*
- `POST /rooms` · `PUT /rooms/{id}` · `DELETE /rooms/{id}` : admin. Corps : `{name, building, capacity, equipment[], ...}` ; 403 · 409 `ROOM_EXISTS` · 422.
- Suppression refusée (409) s'il existe des réservations à venir.

*Front (à faire).* Un écran d'administration « Gérer les cours » dans le module Académique et « Gérer les salles » dans Ressources (formulaire de création, modification, suppression), visibles pour l'admin seulement. Les fonctions d'`api/` et leurs mocks correspondent aux routes ci-dessus.

*Chaque service.* Vérifier le rôle `admin` lui-même (403 sinon), conformément à la règle « chaque service relit le rôle ».

**Alternatives écartées.** Chargement des données directement en base (non reproductible, aucune gestion en production) ; création des cours par les enseignants avec validation par l'admin (statut « en attente » supplémentaire, hors périmètre de la v1).

**Statut :** à confirmer par l'encadrant et par les responsables des modules Académique et Ressources.

## D2 — Structure interne des services : en couches par défaut, hexagonal seulement au cœur métier (validée)

**Contexte.** Le système est un ensemble de microservices (découpage *du système*). Chaque service choisit librement la structure de *son code*.

**Décision.**
- Les services de support (user-service, bibliothèque, vie étudiante…) : **architecture en couches** (routes → controller → service → repository). Simple, suffisante dans environ 80 % des cas.
- Un service au **cœur métier riche** (règles complexes, plusieurs adaptateurs, logique à protéger de l'infrastructure : commandes, paiement, tarification) : **hexagonal / clean** (domaine pur, ports, adaptateurs).
- Le mélange est assumé : deux services du même système peuvent avoir des structures internes différentes.

**Application au user-service.** Couches, avec injection par constructeur et de petites interfaces pour les dépôts, le hasher, le mail et le bus (tests unitaires sans base). Pas de couche « domaine » séparée ni d'entités riches : les règles tiennent dans les services.

**À réévaluer** si le user-service gagne des règles métier substantielles (ex. politiques d'accès complexes, fédération d'identité).

## D3 — API versionnée en parallèle de l'ancienne, pagination additive (validée)

**Contexte.** Le front et la Gateway appellent déjà `/auth/login`, `/users`… Changer ces chemins ou la forme des réponses les casserait.

**Décision.** Un seul routeur d'API monté sur **`/v1` et `/`**. `/v1` est la version canonique pour les nouveaux clients; `/` reste un alias identique. Un futur `/v2` coexistera avec `/v1`. Pagination par `page`/`limit` **facultatifs** : sans eux, la réponse est celle d'avant; seuls des champs (`page`, `limit`, `total`) sont **ajoutés**.

## D4 — Sessions : jeton d'accès court sans état + jeton de rafraîchissement à rotation (validée)

**Contexte.** Un JWT ne peut pas être annulé avant son expiration; le front actuel ne gère pas le rafraîchissement.

**Décision.** Le JWT garde sa durée (`JWT_EXPIRES_IN`, 2 h par défaut) et sa forme. On **ajoute** `refreshToken` à la réponse de connexion (opaque, haché en base, rotation à chaque usage, **rejeu ⇒ révocation de la famille**). `POST /auth/refresh`, `/auth/logout`, `/auth/logout-all`. Réinitialisation du mot de passe et `logout-all` posent `tokensValidAfter` (à la seconde) : les JWT émis avant sont refusés. Changer **son propre** mot de passe ferme seulement les sessions longues (le front continue avec son JWT).

**Limite assumée.** La révocation des jetons d'accès n'agit **que dans le user-service** (qui relit le compte à chaque requête). Les **autres services** vérifient la signature seule : ils acceptent un JWT révoqué jusqu'à son expiration. Pour une révocation immédiate partout : durée de JWT plus courte (+ refresh côté front), ou liste de révocation partagée, ou introspection.

## D5 — Événements : boîte d'envoi (outbox), livraison « au moins une fois » (validée)

**Contexte.** L'écriture en base et la publication sur RabbitMQ ne sont pas transactionnelles ensemble; l'ancienne version perdait l'événement si le bus était indisponible à cet instant et ne se reconnectait jamais.

**Décision.** Les services écrivent l'événement dans la collection `outboxes`; un relais le publie avec **confirmation** du courtier, avec reconnexion et nouvelles tentatives à backoff exponentiel, réservation atomique avec bail. Enveloppe rétro-compatible (`name`, `occurredAt`, `payload` conservés; `id` et `version` ajoutés). Voir `docs/RABBITMQ-ET-EVENEMENTS.md`.

**Limites assumées.** Non atomique avec l'écriture du compte (MongoDB sans replica set) ; doublons possibles ⇒ **consommateurs idempotents** (déduplication par `messageId`) ; ordre garanti seulement au sein d'une instance.

## D6 — Observabilité et exploitation (validée)

Logs JSON structurés avec identifiant de requête; métriques Prometheus (`/metrics` protégé, étiquette de **gabarit** de route); traces OpenTelemetry **désactivées par défaut** (activées par variable d'environnement); sondes `/health` (vivacité) et `/ready` (disponibilité, `DRAINING` à l'arrêt); arrêt progressif; configuration validée au démarrage; image Docker non-root; CI avec audit des dépendances et seuils de couverture.

