# Guide : refaire ce service seul, pas à pas

Ce guide reprend **dans l'ordre** ce qui a été fait, avec pour chaque étape : **l'objectif**, **les commandes**, **le point de contrôle** (comment savoir que c'est bon) et **le piège à éviter**. À suivre dans l'ordre : chaque étape s'appuie sur la précédente.

Légende : 🎯 objectif · ⌨️ commandes · ✅ contrôle · ⚠️ piège.

---

## Étape 0 — Décider avant d'écrire

🎯 Choisir la structure **avant** le code.

1. **Niveau système** : ce service est un microservice parmi d'autres (un métier, sa base, ses événements). C'est le *découpage* — décidé au niveau du projet.
2. **Niveau code** : comment organiser l'intérieur de CE service. Règle retenue : **couches** (`routes → controller → service → repository`) par défaut ; **hexagonal** seulement pour un service au cœur métier riche (commandes, paiement…). Un service de comptes = couches. Voir `docs/DECISIONS.md` D2.
3. **Contraintes à ne pas casser** : le front existe déjà ⇒ on **n'a pas le droit** de changer le JSON des réponses ni les routes. Tout ajout doit être *additif*. (C'est pourquoi les 5 tests d'origine n'ont jamais changé.)

✅ Tu peux répondre à : « Quels sont les consommateurs de mon API et qu'est-ce qui les casserait? »

---

## Étape 1 — Outillage

🎯 Un projet TypeScript strict, exécutable, avec lint.

⌨️
```bash
npm init -y
npm install express mongoose zod jsonwebtoken bcryptjs cors helmet express-rate-limit nodemailer
npm install -D typescript@~5.9 tsx @types/node@22 @types/express@4 @types/cors @types/jsonwebtoken @types/bcryptjs@2 @types/nodemailer
npm install -D eslint @eslint/js typescript-eslint
```
- `package.json` : ajouter `"type": "module"`.
- `tsconfig.json` : `strict: true`, `module` et `moduleResolution` = `NodeNext`, `target: ES2022`, `noEmit: true`.
- `tsconfig.build.json` : étend le précédent avec `noEmit: false`, `rootDir: src`, `outDir: dist`.
- Scripts : `dev` = `node --env-file=.env --watch --import tsx src/server.ts` · `build` = `tsc -p tsconfig.build.json` · `typecheck` = `tsc --noEmit`.

✅ `npx tsc --noEmit` ne renvoie rien.
⚠️ En `NodeNext`, **les imports relatifs doivent finir par `.js`** même dans un fichier `.ts` (`import { x } from "./x.js"`). ⚠️ `typescript-eslint` ne supporte pas encore TypeScript 7 : rester en 5.9.

---

## Étape 2 — Le squelette en dossiers

🎯 Placer chaque fichier au bon endroit **dès le début**.

```
src/
  server.ts  app.ts  container.ts
  config/  shared/  infrastructure/
  modules/<module>/{routes,controllers,services,repositories,dto,models,types}/
test/
```
Règles de dépendance (à ne jamais enfreindre) :
- `controller` : HTTP seulement, **aucune règle métier**.
- `service` : règles métier ; ne connaît **ni Express ni Mongoose** (il parle à des *interfaces*).
- `repository` : seul à connaître MongoDB.
- `routes` : chemins + gardes (auth, validation).

✅ Un nouveau venu devine où est un fichier à partir de son nom.

---

## Étape 3 — Les fondations

Dans cet ordre, car chaque brique sert aux suivantes.

1. **Configuration validée** (`src/config/index.ts`) — lire `process.env` avec un schéma zod, **tous les champs avec un défaut** sauf ceux qui n'ont pas de sens par défaut. Échouer au démarrage avec un message clair.
   ⚠️ Traiter les variables vides (`CLE=`) comme absentes.
2. **Erreurs applicatives** (`shared/errors/app-error.ts`) — `AppError(kind, message, details)` où `kind` décrit la *nature* (`conflict`, `locked`…), **pas** un code HTTP.
3. **Gestionnaire d'erreurs** (`shared/middleware/error-handler.ts`) — un tableau `kind → statut`, et un `500` générique qui journalise sans rien révéler.
4. **Validation** (`shared/middleware/validate.ts`) — applique un schéma zod et met le résultat nettoyé dans `req.dto`.
5. **Logger** (`infrastructure/logging/logger.ts`) — pino; muet en test; masquer `Authorization`.
6. **Ports** (`shared/ports/index.ts`) — interfaces `PasswordHasher`, `TokenService`, `MailService`, `EventPublisher`… (voir étape 4).

✅ Une route de test qui lève `conflict("x")` renvoie bien un 409 JSON.

---

## Étape 4 — Une tranche verticale complète : les comptes (`users`)

🎯 Faire fonctionner **un** module de bout en bout avant d'en faire d'autres. L'ordre qui évite les allers-retours (de l'intérieur vers l'extérieur) :

| # | Fichier | Contenu |
|---|---|---|
| 1 | `types/user.types.ts` | Le type `User` (objet simple, **sans** `passwordHash`), `NewUser`, `UserPatch` |
| 2 | `models/user.model.ts` | Schéma Mongoose (`passwordHash` en `select:false`) |
| 3 | `repositories/user.repository.ts` | **Interface** `UserRepository` + classe `MongoUserRepository` (requêtes `lean`) |
| 4 | `dto/user.dto.ts` | Schémas zod d'entrée **et** fonction de sortie `toUserResponse` (la liste blanche des champs exposés) |
| 5 | `services/user.service.ts` | Les règles. Ne dépend que de l'interface du dépôt et des ports |
| 6 | `controllers/user.controller.ts` | `dtoOf(req)` → service → `res.json(toUserResponse(...))` |
| 7 | `routes/user.routes.ts` | `router.post("/", requireAdmin, validate(dto), asyncHandler(controller.create))` |
| 8 | `container.ts` | `new MongoUserRepository()` → `new UserService({…})` → `new UserController(…)` |

Pourquoi **interface + implémentation** pour le dépôt : le service est testable avec une doublure en mémoire (étape 8).
Pourquoi **DTO de sortie explicite** : on ne renvoie jamais un document tel quel, donc on ne peut pas fuiter un champ interne par accident.

✅ `curl` sur `POST /users` avec un token admin renvoie `201` et un JSON sans `_id` ni `passwordHash`.
⚠️ Mongoose **ignore** une clé `undefined` dans un `update` : pour supprimer un champ, il faut `$unset` (le dépôt le fait dans `toUpdate`).
⚠️ Une requête `lean()` ne renvoie **pas** les champs `select:false` : pour lire le hash, `.select("+passwordHash")` explicitement.

---

## Étape 5 — Authentification et sécurité

1. **Mots de passe** : bcrypt derrière `PasswordHasher`. Jamais de hash dans une réponse.
2. **JWT** derrière `TokenService` (`sub`, `name`, `role`, `iat`).
3. **`authenticate`** : vérifie la signature **puis relit le compte en base** (un rôle retiré ou un compte désactivé prend effet immédiatement). Gardes `requireAdmin`, `selfOrAdmin`, `onlySelf`.
4. **Connexion** : ordre des vérifications = inconnu 401 → suspendu 423 → inactif 403 → mauvais mot de passe. Compteur d'échecs **incrémenté atomiquement** ($inc), suspension au seuil.
5. **Inscription** : le DTO ne déclare **pas** `role` ⇒ zod le supprime ⇒ impossible de s'inscrire admin.
6. **Réponses neutres** : « mot de passe oublié » répond toujours OK; « identifiants invalides » ne dit pas si l'e-mail existe.

⚠️ Ne jamais tester les échecs de connexion sur un vrai compte (le compteur s'incrémente).

---

## Étape 6 — Sessions longues (refresh tokens)

🎯 Pouvoir **annuler** une session sans attendre l'expiration du JWT.

- Jeton de rafraîchissement = valeur aléatoire **opaque**, stockée **hachée** (SHA-256), avec une `familyId` et un TTL.
- **Rotation** : chaque usage consomme l'ancien et en émet un nouveau (consommation **atomique** : `findOneAndUpdate({usedAt:null,…})`).
- **Rejeu** d'un jeton déjà consommé ⇒ on révoque **toute la famille** (vol probable).
- `logout-all` et la réinitialisation du mot de passe : sessions longues fermées **et** `tokensValidAfter` posé ⇒ `authenticate` refuse les JWT émis avant.
- Le champ est *ajouté* à la réponse de login (`refreshToken`) : le front existant l'ignore.

⚠️ `iat` est en **secondes** : tronquer `tokensValidAfter` à la seconde et refuser seulement si `iat` est **strictement antérieur**.
⚠️ Changer **son propre** mot de passe ne doit pas invalider le JWT courant (le front continue après le changement obligatoire du mot de passe temporaire).

---

## Étape 7 — Évolutions d'API sans casser personne

1. **Versionnage** : un seul `Router` d'API monté sur `/v1` **et** sur `/`. Un routeur = un seul limiteur de débit (deux routeurs doubleraient le quota). Sondes et docs non versionnées.
2. **Pagination additive** : `page` et `limit` facultatifs; **sans paramètre le comportement est identique à avant** (page 1, 500 max); la réponse gagne `page`, `limit`, `total` (rien n'est retiré); tri total (`createdAt` puis `_id`) pour que les pages ne se chevauchent pas.

✅ Test : `/v1/x` et `/x` donnent exactement la même réponse.

---

## Étape 8 — Les tests (en même temps que le code, pas après)

Voir `docs/TESTS-ET-VERIFICATION.md`. En résumé :

1. **Doublures** (`test/helpers/fakes.ts`) : dépôts en mémoire, faux hasher, faux mailer, bus qui enregistre.
2. **Unitaires** : un fichier par service; on teste *chaque règle* (cas heureux **et** refus).
3. **Intégration** : `mongodb-memory-server` + `createApp(container).listen(0)` + `fetch`.
4. **`test/setup.ts`** : fixe `NODE_ENV=test` avant tout import (la config est lue une seule fois).
5. Commande : `node --import tsx --import ./test/setup.ts --test test/*.test.ts` (liste explicite sous Windows).

Règle d'or : **ne jamais modifier une assertion d'un test d'intégration existant** pour faire passer une refonte; si tu dois le faire, c'est que tu as cassé le contrat.

---

## Étape 9 — Événements fiables (outbox)

Voir `docs/RABBITMQ-ET-EVENEMENTS.md` (explication complète). Ordre de construction :

1. `event-envelope.ts` — le format du message (garder les champs historiques, ajouter `id` + `version`).
2. `outbox.model.ts` / `outbox.repository.ts` — la collection et la **réservation atomique avec bail**.
3. `outbox-publisher.ts` — ce que les services appellent (écrit en base).
4. `event-bus.ts` — le transport RabbitMQ (canal **à confirmations**, écouteurs `error`/`close`).
5. `outbox-relay.ts` — la boucle (reconnexion + backoff, ordre, arrêt propre).
6. Câblage dans `container.ts`; démarrage du relais dans `server.ts` **uniquement** (pas dans `createApp`, pour que les tests n'aient pas de minuterie).
7. Passer `publish` en `async` et mettre un `await` à **chaque** appel.

✅ Test réel : arrêter RabbitMQ, créer 2 comptes (l'API répond 201), redémarrer RabbitMQ ⇒ les 2 événements arrivent dans l'ordre.

---

## Étape 10 — Exploitation

1. **Sondes** : `/health` (vivant + base), `/ready` (dépendances; `DEGRADED` si RabbitMQ est configuré mais injoignable; `DRAINING` à l'arrêt).
2. **Métriques** (`prom-client`) : définir les métriques **au niveau du module** (pas dans une fonction appelée plusieurs fois); étiquette `route` = **gabarit** (`/users/:id`), **jamais l'URL réelle**; protéger `/metrics`.
3. **Traces** (OpenTelemetry) : `src/instrumentation.ts` chargé par `--import` **avant** l'app; vérifier visuellement la sortie.
4. **Arrêt progressif** : `/ready`→503 ; attente ; `server.close` ; puis relais → RabbitMQ → MongoDB.
5. **Robustesse au démarrage** : délais Mongo bornés; `unhandledRejection`/`uncaughtException` ⇒ log fatal + sortie (l'orchestrateur relance).

---

## Étape 11 — Livraison

1. **Dockerfile** en 3 étapes (compilation, dépendances de prod, exécution); utilisateur non-root; `HEALTHCHECK`.
   ⌨️ `docker build -t smartcampus-user-service .`
2. **CI** : lint → typecheck → build → `npm audit --omit=dev --audit-level=high` → tests avec seuils de couverture → build Docker + test de fumée.
3. **Dependabot** : mises à jour hebdomadaires.
4. **`docker-compose.yml`** : MongoDB, Mailpit, RabbitMQ pour le développement.

✅ `docker run` du conteneur, puis `curl /health` ⇒ UP, `docker inspect` ⇒ `healthy`.

---

## Recette A — Ajouter une route à un module existant

Exemple : `GET /users/:id/summary`.
1. Si le JSON est nouveau : une fonction `toSummaryResponse` dans `dto/user.dto.ts` (et le schéma d'entrée si besoin).
2. Une méthode dans le **service** (la règle).
3. Si besoin de nouvelles données : une méthode dans l'**interface** `UserRepository` **et** dans `MongoUserRepository` **et** dans la doublure de test `InMemoryUserRepository`.
4. Une méthode dans le **controller** (lecture du DTO → service → réponse).
5. La ligne dans `routes/user.routes.ts`, avec ses gardes et `validate(...)`.
6. La route dans `src/docs/openapi.ts`.
7. Tests : unitaire du service (heureux + refus) et, si la route est publique/sensible, un test d'intégration.
8. `npm run check`.

## Recette B — Ajouter un module

1. Créer `src/modules/<nom>/{routes,controllers,services,repositories,dto,models,types}/` (seulement les dossiers utiles).
2. Construire dans l'ordre de l'étape 4 (types → modèle → dépôt → DTO → service → controller → routes).
3. Câbler dans `container.ts` et monter le routeur dans `app.ts` (dans le routeur d'API unique `api`).
4. Documenter dans `docs/REFERENCE-FICHIERS.md` et `src/docs/openapi.ts`.

## Recette C — Ajouter un événement

Voir `docs/RABBITMQ-ET-EVENEMENTS.md` §8.

## Recette D — Ajouter une variable de configuration

1. Ajouter la ligne au schéma zod de `src/config/index.ts` **avec un défaut** (pour que les `.env` existants restent valides).
2. L'exposer dans l'objet `config`.
3. La documenter dans `.env.example`.
4. Si un test a besoin d'une valeur particulière, la fixer dans `test/setup.ts`.

---

## Check-list avant de livrer

```bash
npm run check          # lint + types + tests
npm run test:coverage  # seuils de couverture
npm run audit:prod     # 0 vulnérabilité haute
npm run build          # compile
docker build -t smartcampus-user-service .
```
Puis démarrer vraiment le service (`npm run dev`) et vérifier `/health`, `/ready`, `/docs`, une connexion. **Les tests verts ne prouvent pas que le démarrage réel fonctionne.**
