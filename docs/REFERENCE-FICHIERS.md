# Référence : à quoi sert chaque fichier

Pour chaque fichier : **rôle**, **ce qu'il contient d'important**, **qui l'utilise**. Les chemins sont relatifs à la racine du dépôt.

Convention de nommage : `*.routes.ts` (chemins) → `*.controller.ts` (HTTP) → `*.service.ts` (métier) → `*.repository.ts` (base) ; `*.dto.ts` (formes d'entrée/sortie) ; `*.model.ts` (schéma Mongoose) ; `*.types.ts` (types).

Le chemin d'une requête : **routes → controller → service → repository → MongoDB**, voir `docs/ARCHITECTURE.md`.

---

## 1. Fichiers à la racine

| Fichier | Rôle |
|---|---|
| `package.json` | Dépendances et **commandes** : `dev`, `build`, `start`, `check`, `lint`, `typecheck`, `test`, `test:coverage`, `audit:prod`, `seed`, `set-role`. `"type": "module"` = ES modules. |
| `package-lock.json` | Versions exactes installées (reproductibilité : `npm ci` l'utilise). **À commiter.** |
| `tsconfig.json` | TypeScript **strict**, `module: NodeNext` (imports avec extension `.js`), `noEmit` : sert à **vérifier** les types (src + test). |
| `tsconfig.build.json` | Hérite du précédent mais **émet** vers `dist/` (uniquement `src`). Utilisé par `npm run build`. |
| `eslint.config.js` | Règles de lint (typescript-eslint). Les variables préfixées `_` peuvent être inutilisées. |
| `.env` | Configuration locale **secrète** (jamais dans git). |
| `.env.example` | Modèle documenté de toutes les variables (dans git). Voir aussi `src/config/index.ts`. |
| `.gitignore`, `.dockerignore` | Exclusions git / contexte de build Docker (pas de `node_modules`, `.env`, `test`, `docs`). |
| `Dockerfile` | Image en **3 étapes** : `build` (compile TS) → `deps` (dépendances de production seules) → `runtime` (Node 22 alpine, utilisateur **non-root** `node`, `HEALTHCHECK` sur `/health`). Lance `node --import ./dist/instrumentation.js dist/server.js`. |
| `docker-compose.yml` | Dépendances locales (MongoDB, Mailpit, RabbitMQ) ; `--profile full` ajoute le service lui-même. |
| `.github/workflows/ci.yml` | Intégration continue (lint, types, build, audit, couverture, test de fumée du conteneur). |
| `.github/dependabot.yml` | Mises à jour automatiques hebdomadaires. |
| `README.md`, `handoff.md` | Présentation et passation. |
| `docs/` | Documentation (voir §8). |

---

## 2. Point d'entrée et assemblage (`src/`)

| Fichier | Rôle |
|---|---|
| `src/server.ts` | **Démarre tout**, dans cet ordre : construit **un seul** conteneur → connecte MongoDB (échec = log fatal + sortie) → `seed()` → connecte RabbitMQ (échec non fatal) → démarre le relais d'outbox → `listen`. Gère `EADDRINUSE`, `unhandledRejection`/`uncaughtException` (log fatal puis sortie), et l'**arrêt progressif** (SIGINT/SIGTERM : `/ready`→503, attente `SHUTDOWN_DRAIN_MS`, fermeture serveur → relais → RabbitMQ → MongoDB). |
| `src/app.ts` | `createApp(container)` : construit l'application Express. **L'ordre des middlewares compte** : `/openapi.json` + `/docs` (avant `helmet`, la CSP bloquerait Swagger) → `helmet` → journal `pino-http` (id de requête) → `cors` → `express.json(1 Mo)` → `httpMetrics` → sondes → `/metrics` → **un seul routeur d'API monté sur `/v1` et sur `/`** → 404 → gestionnaire d'erreurs. Un seul routeur = un seul limiteur de débit sur `/auth`. |
| `src/container.ts` | **Racine de composition** : le *seul* endroit qui fait les `new` des classes concrètes et câble `repository → service → controller`. Renvoie un objet avec tout ce dont `app.ts`, `server.ts`, les tests et `seed` ont besoin. Pour changer une implémentation (ex. un faux mailer), c'est ici. |
| `src/instrumentation.ts` | Traces OpenTelemetry. Chargé **avant** l'application (`--import`). Inactif sans `OTEL_EXPORTER_OTLP_ENDPOINT` ou `OTEL_TRACES_EXPORTER=console`. |
| `src/config/index.ts` | Lit `process.env`, **valide avec zod** (types, bornes, défauts), refuse de démarrer sur une valeur invalide (`Configuration invalide : …`) ou avec le secret JWT par défaut en production. Exporte `config` (objet typé) et `Config`. |
| `src/docs/openapi.ts` | Contrat **OpenAPI 3** servi sur `/docs` et `/openapi.json`. Les corps de requête sont **générés depuis les DTO zod** (`toJSONSchema`) : documentation et validation ont la même source. |
| `src/bootstrap/seed.ts` | `seed(container)` idempotent : crée les index, insère les permissions par défaut, crée l'**administrateur fixe** (`FIRST_ADMIN_*`) s'il n'existe pas. |
| `src/scripts/seed.ts` | Commande `npm run seed` (connecte, appelle `seed`, déconnecte). |
| `src/scripts/set-role.ts` | Commande `npm run set-role -- adresse@x.tn admin` : change un rôle hors interface (dépannage). |
| `src/types/express.d.ts` | Ajoute `req.user`, `req.dto` (et `req.id` de pino-http) au type `Request` d'Express. Sans lui, TypeScript refuserait ces propriétés. |

---

## 3. Socle partagé (`src/shared/`)

Code utilisé par tous les modules, sans logique métier propre à un module.

| Fichier | Rôle |
|---|---|
| `shared/constants/index.ts` | `ROLES`, `USER_STATUSES`, préfixes de matricule, types de jetons, **noms d'événements** (`DOMAIN_EVENTS`) et leurs types TypeScript. Une seule source de vérité. |
| `shared/errors/app-error.ts` | `AppError(kind, message, details)` + fabriques (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `locked`). L'erreur décrit sa **nature**, pas un code HTTP. |
| `shared/middleware/error-handler.ts` | **Seul endroit** qui traduit `kind` → statut HTTP (`STATUS_BY_KIND`). Gère aussi JSON invalide (400), corps trop gros (413), doublon Mongo (409). Pour toute autre erreur : log détaillé (avec l'id de requête) et réponse **500 générique** (aucune fuite). |
| `shared/middleware/validate.ts` | `validate(schemaZod, "body"|"query")` : valide, **nettoie** (retire les clés inconnues) et place le résultat dans `req.dto`. `dtoOf<T>(req)` le relit typé. |
| `shared/middleware/async-handler.ts` | Enveloppe un handler `async` pour que ses erreurs aillent au gestionnaire d'erreurs (Express 4 ne le fait pas seul). |
| `shared/ports/index.ts` | **Interfaces** dont le métier a besoin : `PasswordHasher`, `TokenService`, `MailService`, `EventPublisher`, `SessionStore`. Le métier dépend de ça, pas de bcrypt/JWT/SMTP/RabbitMQ. |
| `shared/utils/request-context.ts` | `requestContext(req)` (IP + User-Agent, sans que les services dépendent d'Express) et `currentUser(req)`. |
| `shared/utils/full-name.ts`, `user-agent.ts` | `Prénom Nom` ; « Chrome · Windows » à partir du User-Agent. |
| `shared/validation/fields.ts` | Briques zod réutilisées (`nameField`, `emailField`, `roleField`, `passwordField`). |
| `shared/validation/policies.ts` | Règles : e-mail du domaine institutionnel, mot de passe fort, échappement des regex (anti-injection de recherche). |

---

## 4. Infrastructure (`src/infrastructure/`)

Les **adaptateurs** : tout ce qui parle au monde extérieur.

| Fichier | Rôle |
|---|---|
| `database/mongo.ts` | `connectDatabase(uri, options)` (pool, délai de sélection de serveur borné), `disconnectDatabase`, `isDatabaseUp`, `ensureIndexes` (crée les index **avant** d'insérer). |
| `logging/logger.ts` | Logger **pino** : JSON en production, joli en développement (`pino-pretty`), muet en test ; masque `Authorization` et `Cookie`. |
| `security/password-hasher.ts` | bcrypt (coût 10) derrière l'interface `PasswordHasher`. |
| `security/token-service.ts` | JWT (`sub`, `name`, `role`, `iat`) derrière `TokenService`. |
| `security/random.ts` | Mot de passe temporaire (10 car., sans caractères ambigus, `crypto.randomInt`), jetons aléatoires, code à 6 chiffres, SHA-256. |
| `mail/mailer.ts` | `SmtpMailer` (Nodemailer). Un échec d'envoi est **journalisé sans faire échouer** la création du compte. |
| `mail/templates.ts` | Gabarits HTML + texte des e-mails (compte créé, code de vérification, réinitialisation). |
| `messaging/event-envelope.ts` | Format du message : `id`, `name`, `version`, `occurredAt`, `payload` ; clé de routage `user.<nom>`. |
| `messaging/outbox.model.ts` / `outbox.repository.ts` | Collection `outboxes` ; **réservation atomique avec bail**, marquage publié (TTL), échec avec prochaine échéance, comptage des en-attente. |
| `messaging/outbox-publisher.ts` | Ce que les services appellent : écrit l'événement en base (si RabbitMQ configuré). Ne fait jamais échouer le métier. |
| `messaging/outbox-relay.ts` | Boucle qui lit la boîte et publie sur le bus (reconnexion + backoff, ordre, `runOnce` testable, `stop` propre). |
| `messaging/event-bus.ts` | `RabbitEventBus` : connexion, **canal à confirmations**, exchange topic durable, `publish` résolu sur ack, `status()`, `close()`. |
| `observability/metrics.ts` | Registre Prometheus + métriques (durée HTTP, tentatives de connexion, événements, jauge `outbox_pending_events`). Défini **une fois** au niveau du module. |
| `observability/http-metrics.ts` | Middleware qui mesure chaque requête ; étiquette `route` = **gabarit** (`/users/:id`) ; `/v1` fusionné avec l'alias. |

Détail complet de la messagerie : `docs/RABBITMQ-ET-EVENEMENTS.md`.

---

## 5. Modules (`src/modules/`)

### 5.1 `auth/` — connexion et cycle de vie du mot de passe
| Fichier | Rôle |
|---|---|
| `routes/auth.routes.ts` | `POST /auth/login`, `register`, `verify-email`, `resend-activation`, `forgot-password`, `reset-password`, `refresh`, `logout`, `logout-all` (celui-ci exige un JWT). |
| `controllers/auth.controller.ts` | Lit le DTO validé, appelle le service, formate la réponse (`toLoginResponse`). Aucune règle. |
| `services/auth.service.ts` | **Règles de connexion** dans l'ordre : inconnu 401 → suspendu 423 → inactif 403 → mauvais mot de passe (incrément **atomique**, suspension au seuil) ; succès (remise à zéro, historique, jeton d'accès + jeton de rafraîchissement) ; inscription (toujours `student`) ; vérification d'e-mail ; mot de passe oublié/réinitialisé ; `refresh`, `logout`, `logoutAll`. |
| `services/session.service.ts` | **Sessions longues** : ouverture (nouvelle famille), `rotate` (consomme l'ancien jeton, émet le suivant, **rejeu ⇒ famille révoquée**), `close`, `closeAll`. |
| `dto/auth.dto.ts` | Schémas d'entrée (login, register — *sans champ `role`*, e-mail, vérification, réinitialisation, refresh) et `toLoginResponse`. |
| `middleware/auth.middleware.ts` | `authenticate` (vérifie la signature, **relit le compte en base**, refuse si inactif ou si `iat` antérieur à `tokensValidAfter`), `requireAdmin`, `selfOrAdmin`, `onlySelf`. |
| `models/refresh-token.model.ts`, `repositories/refresh-token.repository.ts` | Jetons de rafraîchissement **hachés** ; `claim` atomique ; révocation par famille / par utilisateur ; TTL. |
| `models/verification-token.model.ts`, `repositories/verification-token.repository.ts` | Codes d'e-mail et jetons de réinitialisation (hachés, à usage unique, TTL). |

### 5.2 `users/` — comptes
| Fichier | Rôle |
|---|---|
| `routes/user.routes.ts` | `POST/GET /users`, `GET/PUT/DELETE /users/:id`, `PUT …/password`, `…/avatar`, `…/role`, `PATCH …/status`, `GET …/login-history`. Chaque route déclare ses gardes (`requireAdmin`, `selfOrAdmin`, `onlySelf`) puis `validate`. |
| `controllers/user.controller.ts` | Traduction HTTP ↔ service. |
| `services/user.service.ts` | **Règles des comptes** : matricule `ETU-2026-0001` (séquence atomique par rôle), création par admin (mot de passe temporaire + e-mail + événement), liste filtrée **paginée** + statistiques globales, profil, avatar, changement de mot de passe (ferme les sessions longues), changement de rôle (événement seulement si différent), statut, suppression, **auto-protection de l'admin** (`SELF_PROTECTED`). |
| `repositories/user.repository.ts` | Interface `UserRepository` + implémentation Mongo : requêtes `lean` (objets simples), `update` qui traduit `undefined` en `$unset`, incrément atomique, recherche échappée, tri total `createdAt` puis `_id`. |
| `models/user.model.ts` | Schéma `User` (`_id` = matricule, `passwordHash` en `select:false`) et compteurs. |
| `dto/user.dto.ts` | Schémas d'entrée + **`toUserResponse`** : la frontière avec le front (jamais `_id`, `passwordHash`, `emailVerified`, `tokensValidAfter`). |
| `types/user.types.ts` | `User` (objet simple, sans hash), `UserWithPassword`, `NewUser`, `UserPatch`, filtres, pagination, stats. |

### 5.3 `roles/` — permissions
| Fichier | Rôle |
|---|---|
| `constants/permission.catalog.ts` | Catalogue des 13 permissions et droits par défaut par rôle. |
| `services/role.service.ts` | Matrice rôle × permission ; `setPermission` (refuse une permission inconnue, verrouille `users.*` pour l'admin) ; insertion initiale sans écraser les choix de l'admin. |
| `repositories/permission.repository.ts`, `models/permission.model.ts` | Persistance (index unique `{role, key}`, `$setOnInsert`). |
| `controllers/`, `routes/`, `dto/` | `GET/PUT /roles/permissions`, réservé aux admins. |

### 5.4 `login-history/` — historique
| Fichier | Rôle |
|---|---|
| `services/login-history.service.ts` | Enregistre chaque tentative (IP, appareil) et incrémente la métrique `auth_login_attempts_total`. |
| `repositories/`, `models/login-event.model.ts` | Persistance, tri par date décroissante. |
| `controllers/`, `routes/`, `dto/` | `GET /login-history` (admin) ; `GET /users/:id/login-history` est monté par le module `users`. |

### 5.5 `health/` — exploitation
| Fichier | Rôle |
|---|---|
| `routes/health.routes.ts` | `/health` (vivant + base) et `/ready` (dépendances, `DEGRADED` si RabbitMQ est configuré mais injoignable, **`DRAINING`** pendant l'arrêt). |
| `routes/metrics.routes.ts` | `/metrics` (Prometheus) : jeton exigé s'il est défini ; **404 en production sans jeton**. |

---

## 6. Tests (`test/`)

| Fichier | Rôle |
|---|---|
| `setup.ts` | Fixe `NODE_ENV=test` **avant** tout import (la config est lue une seule fois). Chargé par `--import ./test/setup.ts`. |
| `helpers/fakes.ts` | **Doublures en mémoire** : dépôts (utilisateurs, jetons de rafraîchissement), hasher, jetons, mailer, bus d'événements enregistreur. |
| `user.service.test.ts`, `auth.service.test.ts`, `session.service.test.ts`, `outbox.test.ts`, `platform.test.ts` | Tests **unitaires** (voir `docs/TESTS-ET-VERIFICATION.md` §3). |
| `api.test.ts` | Tests d'**intégration** HTTP avec MongoDB en mémoire (§4 du même document). |

---

## 7. Qui appelle qui (vue d'ensemble)

```
server.ts ──► container.ts ──► (adaptateurs infrastructure) + (repositories) + (services) + (controllers)
        └───► app.ts ────────► routes/*.ts ──► validate ──► controller ──► service ──► repository ──► MongoDB
                                                                      └──► ports (hasher, mailer, events, sessions)
```

## 8. Les autres documents

| Document | Contenu |
|---|---|
| `docs/GUIDE-CONSTRUCTION.md` | **Comment tout refaire seul**, pas à pas. |
| `docs/RABBITMQ-ET-EVENEMENTS.md` | RabbitMQ, outbox, relais : explication technique. |
| `docs/TESTS-ET-VERIFICATION.md` | Comment tester, ce qui a été vérifié. |
| `docs/DEPANNAGE.md` | Méthode de diagnostic, incidents réels, pannes d'exploitation. |
| `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` | Architecture et décisions. |
| `docs/GUIDE-INGENIEUR.md`, `PRD.md`, `INTEGRATION-FRONT-BACK.md`, `NOTE-EQUIPE.md`, `QUESTIONS-JURY.md` | Contexte projet. |
