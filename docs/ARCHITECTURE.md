# Architecture du user-service et explication du code

## 1. Vue d'ensemble : les microservices

SmartCampus est découpé en **6 microservices**, un par module du front : `user-service`, `academic`, `resources`, `housing`, `student-life`, `library`.
Principes appliqués :

- **Un service = un métier = sa base.** Le user-service possède la base `smartcampus_users`. Aucun autre service ne la lit : ils passent par son API ou par ses événements.
- **Un point d'entrée : l'API Gateway** (`/api`). Le front ne connaît que la Gateway, qui route vers le bon service et retire le préfixe `/api`.
- **Authentification centralisée, vérification distribuée.** Seul le user-service *émet* le JWT. Chaque autre service le *vérifie* (même `JWT_SECRET`) et lit `sub`, `name`, `role`.
- **Communication asynchrone par événements** (RabbitMQ) pour informer les autres services sans les coupler (ex. `UtilisateurCréé`).

```
 Navigateur (React)
      │  HTTP + Authorization: Bearer <JWT>
      ▼
 API Gateway  (/api/*)
      │
      ├──► user-service  :4001 ──► MongoDB  smartcampus_users
      │         │  ├─► SMTP (Mailpit en dev)   e-mails
      │         │  └─► RabbitMQ exchange topic  user.UtilisateurCréé / user.RôleModifié
      ├──► academic · resources · housing · student-life · library   (autres équipes)
```

En développement, la Gateway n'existe pas encore : le front appelle directement `http://localhost:4001` (CORS ouvert pour `http://localhost:5173`).

## 2. Architecture interne du user-service (niveau code)

> **Deux niveaux à ne pas confondre.** La section 1 décrit le **système** : comment SmartCampus est découpé en services, qui possède quelles données, comment ils communiquent (microservices). Cette section décrit l'**intérieur d'un seul service** : comment son code est organisé. Chaque service d'un système de microservices peut avoir une structure interne différente.

**Choix pour le user-service : architecture en couches (layered).** C'est un service de support (comptes, authentification, rôles) : ses règles métier sont limitées, une structure en couches simple suffit. Une architecture hexagonale / clean est réservée aux services au cœur métier riche (commandes, paiement, tarification…) : voir `docs/DECISIONS.md`, D2.

```
HTTP ─► routes ─► controller ─► service ─► repository ─► MongoDB
          │           │            │
          │           │            └─ règles métier (aucune dépendance à Express)
          │           └─ HTTP seulement : DTO d'entrée → service → DTO de sortie
          └─ chemins + middlewares (auth, validation zod)
```

Organisation **par module métier** (`auth`, `users`, `roles`, `login-history`). Dans chaque module, **un dossier par type de fichier** : `routes/`, `controllers/`, `services/`, `repositories/`, `dto/`, `models/`, `types/` (et `middleware/` ou `constants/` quand le module en a besoin). Un fichier se trouve donc toujours au même endroit d'un module à l'autre.

| Dossier | Rôle |
|---|---|
| `server.ts`, `app.ts`, `container.ts` | Démarrage ; assemblage Express ; câblage des dépendances (injection par constructeur) |
| `config/` | Variables d'environnement, validées au démarrage (zod) |
| `shared/` | Socle partagé : constantes, erreurs applicatives, ports (interfaces), middlewares (validation, erreurs), politiques de validation |
| `infrastructure/` | Accès techniques : MongoDB, SMTP, RabbitMQ, bcrypt/JWT, logger (pino) |
| `modules/<module>/` | Un dossier par type de fichier : `routes/` → `controllers/` → `services/` → `repositories/` ; `dto/` (entrée zod / sortie) ; `models/` ; `types/` |
| `docs/openapi.ts` | Contrat OpenAPI généré depuis les DTO zod (`/docs`, `/openapi.json`) |
| `modules/health/` | Sondes `/health` (vivacité) et `/ready` (dépendances) |

Règles de dépendance :
- Le **controller** ne contient aucune règle métier ; le **service** ne connaît ni Express ni Mongoose ; seul le **repository** parle à MongoDB et renvoie des objets simples (`lean`), jamais des documents Mongoose.
- Les **erreurs** décrivent leur nature (`conflict`, `locked`…), pas un code HTTP : un seul tableau (`STATUS_BY_KIND`) les traduit en statut.
- Le service dépend de petites interfaces (dépôts, hasher, mail, bus) injectées dans le constructeur : cela permet des tests unitaires sans base. C'est la seule concession à l'hexagonal ; on n'en ajoute pas davantage ici.

**Exploitation (niveau système)** : `/health` et `/ready` pour l'orchestrateur, `x-request-id` propagé dans tous les logs JSON, arrêt propre sur SIGTERM, `Dockerfile` multi-étapes sans root, configuration uniquement par variables d'environnement, service sans état (le JWT est vérifié par chaque service avec le même secret).

## 3. Base de données MongoDB

Base `smartcampus_users`, 7 collections :

| Collection | Contenu | Points importants |
|---|---|---|
| `users` | Comptes | `_id` = matricule (`ETU-2026-0001`) ; `email` unique ; `passwordHash` en `select:false` (jamais lu sauf demande explicite) ; index sur `role` et `status` |
| `loginevents` | Une ligne par tentative de connexion | `userId`, `ip`, `device`, `success`, `date` |
| `permissions` | Une ligne par couple (rôle, permission) | Index unique `{role, key}` |
| `tokens` | Codes de vérification et jetons de réinitialisation | Valeur **hachée** ; index TTL `expiresAt` : MongoDB supprime les expirés |
| `counters` | Séquences par rôle | `findOneAndUpdate + $inc` : incrément atomique, donc pas de matricule en double |
| `refreshtokens` | Jetons de rafraîchissement (sessions longues) | Valeur **hachée** (index unique) ; `familyId` (révocation par famille) ; `usedAt`/`revokedAt` ; index TTL `expiresAt` |
| `outboxes` | Boîte d'envoi des événements de domaine | `eventId` unique ; `status` `pending`→`published` ; `lockedUntil` (bail), `nextAttemptAt` (backoff) ; index TTL `expiresAt` posé à la publication. Voir `docs/RABBITMQ-ET-EVENEMENTS.md` |

Le compte porte aussi `tokensValidAfter` (facultatif) : les jetons d'accès émis avant cette date sont refusés (voir `docs/DECISIONS.md` D4).

## 4. Les fichiers importants

### Démarrage et assemblage
- `src/server.ts` : crée **un seul** conteneur, connecte MongoDB, exécute `seed()`, connecte RabbitMQ (optionnel), écoute. Sur SIGINT/SIGTERM : arrêt propre (plus de nouvelles connexions, fermeture de la base, délai maximum 10 s).
- `src/app.ts` : ordre voulu : documentation `/docs` → `helmet` → journalisation (id de requête) → `cors` → `express.json` (1 Mo) → sondes → routeurs → 404 → gestionnaire d'erreurs. `rateLimit` seulement sur `/auth`.
- `src/container.ts` : **racine de composition**, le seul endroit qui connaît les implémentations concrètes (repositories → services → controllers).
- `src/config/index.ts` : lit et **valide** l'environnement ; refuse de démarrer sur une valeur invalide ou avec le secret JWT par défaut en production.

### Socle (`shared/`) et infrastructure
- `shared/errors/app-error.ts` : `AppError(kind, message, details)` et fabriques (`conflict`, `locked`…).
- `shared/middleware/error-handler.ts` : traduction nature → statut HTTP ; 500 sans fuite d'information (détail dans les logs avec l'id de requête).
- `shared/middleware/validate.ts` : applique un schéma zod (DTO d'entrée), expose `req.dto` nettoyé. Un client ne peut pas s'inscrire comme admin : `registerDto` ne déclare pas `role`.
- `infrastructure/security/` : bcrypt (coût 10), JWT (`sub`, `name`, `role`), mots de passe temporaires (`crypto.randomInt`), hachage SHA-256 des codes.
- `infrastructure/mail/` : Nodemailer ; un échec d'envoi est journalisé et ne fait pas échouer la création du compte.
- `infrastructure/messaging/event-bus.ts` : journalise toujours, publie sur RabbitMQ si connecté ; `status()` alimente `/ready`.

### Modules
- `modules/auth` (`services/auth.service.ts`) : login (ordre voulu : inconnu 401 → suspendu 423 → inactif 403 → mauvais mot de passe, avec incrément **atomique** du compteur et suspension au seuil), inscription (toujours `student`), vérification d'e-mail, mot de passe oublié/réinitialisé (jetons hachés, usage unique, TTL). `middleware/auth.middleware.ts` relit le compte en base à chaque requête.
- `modules/users` : création par un admin (mot de passe temporaire), liste filtrée + statistiques, profil, mot de passe, photo, rôle (publie `RôleModifié`), statut, suppression ; l'admin ne peut pas se retirer ses propres droits (`SELF_PROTECTED`). `dto/user.dto.ts` définit le JSON exposé (jamais `_id`, `passwordHash`, `emailVerified`).
- `modules/roles` : catalogue de 13 permissions et matrice rôles × permissions ; les valeurs par défaut sont insérées avec `$setOnInsert` (les changements de l'admin ne sont pas écrasés au redémarrage).
- `modules/login-history` : une ligne par tentative (IP, appareil déduit du User-Agent).
- `bootstrap/seed.ts` et `scripts/` : données de départ idempotentes et outils CLI (`npm run seed`, `npm run set-role`).

### Tests (`test/`)
- Unitaires (sans base, avec doublures en mémoire) : `user.service`, `auth.service`, `platform` (erreurs, DTO, politiques).
- Intégration (HTTP réel, MongoDB en mémoire) : `api.test.ts`, y compris `/ready`, OpenAPI et le contrat JSON.

## 5. Sécurité : résumé des choix

| Risque | Parade |
|---|---|
| Mots de passe volés en base | bcrypt ; hash jamais exposé (`select:false` + DTO de sortie) |
| Devinette de mot de passe | Verrouillage à 5 essais + rate limit sur `/auth` |
| Énumération de comptes | `forgot-password` toujours OK ; message de connexion générique |
| Élévation de privilège | Rôle d'inscription fixé côté serveur ; rôle relu en base à chaque requête |
| Injection | zod sur toutes les entrées ; regex échappées |
| Jeton de réinitialisation volé en base | Stocké haché, usage unique, expiration TTL |
| Verrouillage des admins | Auto-protection (R6, R7) |

## 6. Lancer et tester

```bash
docker compose up -d mongo mailpit      # MongoDB :27017 · Mailpit SMTP :1025, interface :8025
cp .env.example .env
npm run dev                             # :4001
npm run check                           # lint + typecheck + tests (unitaires et intégration)
npm run build && npm start              # version compilée
# Documentation interactive : http://localhost:4001/docs
```

## 7. Briques de production (résumé)

| Sujet | Où | Documentation détaillée |
|---|---|---|
| Sessions longues, révocation | `modules/auth/services/session.service.ts`, `auth.middleware.ts` | `docs/DECISIONS.md` D4 |
| Événements fiables (outbox + relais) | `infrastructure/messaging/` | `docs/RABBITMQ-ET-EVENEMENTS.md` |
| Versionnage `/v1`, pagination | `app.ts`, `modules/users/` | `docs/DECISIONS.md` D3 |
| Logs, métriques, traces, sondes | `infrastructure/logging/`, `infrastructure/observability/`, `instrumentation.ts`, `modules/health/` | `docs/DEPANNAGE.md` |
| Conteneur, CI, mises à jour | `Dockerfile`, `.github/` | `docs/GUIDE-CONSTRUCTION.md` étape 11 |
| Fichier par fichier | — | `docs/REFERENCE-FICHIERS.md` |
