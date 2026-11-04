# Comment le service a été testé, exactement

Ce document décrit **chaque niveau de vérification**, ce qu'il prouve, la commande pour le refaire, et ce qui a été observé. Rien ici n'est théorique : ce sont les vérifications réellement exécutées pendant la construction.

## Vue d'ensemble : la pyramide

```
                 ▲  peu nombreux, lents, proches de la production
   7. CI GitHub  │  (lint + types + build + audit + couverture + conteneur réel)
   6. Scénarios réels (Docker : conteneur, RabbitMQ en panne/reprise, arrêt progressif)
   5. Démarrage réel (serveur compilé + vraie base + traces OpenTelemetry)
   4. Intégration HTTP (vraie API Express + vraie MongoDB en mémoire)
   3. Unitaires de la couche métier (doublures en mémoire, aucune base)
   2. Analyse statique : ESLint
   1. Analyse statique : compilateur TypeScript strict
                 ▼  nombreux, rapides, précis
```

Principe : **plus on monte, plus c'est réaliste mais lent**. Les erreurs de logique se trouvent en bas (millisecondes) ; les erreurs d'environnement (réseau, droits, ordre de démarrage) ne se trouvent qu'en haut.

Commande unique pour les niveaux 1 à 4 : `npm run check` (lint + typecheck + tous les tests). Avec seuils de couverture : `npm run test:coverage`.

---

## Mode d'emploi : utiliser les tests au quotidien

| Je veux… | Commande |
|---|---|
| Tout vérifier avant de commiter | `npm run check` |
| Seulement lancer les tests | `npm test` |
| Lancer **un seul fichier** | `node --import tsx --import ./test/setup.ts --test test/auth.service.test.ts` |
| Lancer **un seul test** par son nom | `node --import tsx --import ./test/setup.ts --test --test-name-pattern="rejeu" test/session.service.test.ts` |
| Voir la couverture ligne par ligne | `npm run test:coverage` (affiche les lignes **non couvertes** par fichier) |
| Relancer à chaque modification | ajouter `--watch` : `node --import tsx --import ./test/setup.ts --test --watch test/user.service.test.ts` |
| Voir les logs du service pendant un test | `LOG_LEVEL=debug` ne suffit pas (le logger est muet en test) : retirer temporairement `config.isTest ? "silent"` dans `src/infrastructure/logging/logger.ts`, ou ajouter un `console.log` dans le test |
| Déboguer pas à pas | `node --inspect-brk --import tsx --import ./test/setup.ts --test test/outbox.test.ts` puis ouvrir `chrome://inspect` |

**Lire un échec** : Node affiche `actual` (ce que le code a renvoyé) et `expected` (ce que le test attendait), avec `+`/`-` ligne par ligne, et la ligne du test (`test\xxx.test.ts:44:3`). Les deux cas possibles : le code est faux, **ou** l'attente du test est fausse (voir `docs/DEPANNAGE.md`, incident n°6).

**Écrire un nouveau test unitaire** (modèle) :

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { UserService } from "../src/modules/users/services/user.service.js";
import { InMemoryUserRepository, fakeHasher, makeUser, noSessions, recordingBus, silentMailer } from "./helpers/fakes.js";

test("une règle, décrite en une phrase", async () => {
  const admin = makeUser({ _id: "ADM-2026-0001", role: "admin" });
  const repo = new InMemoryUserRepository([admin]);            // 1. préparer l'état
  const service = new UserService({                             // 2. assembler avec des doublures
    userRepository: repo, passwordHasher: fakeHasher, mailer: silentMailer(),
    eventBus: recordingBus(), sessionStore: noSessions,
    config: { emailDomain: "smartcampus.tn", exposeTempPassword: false },
  });
  await assert.rejects(                                         // 3. agir + vérifier le refus
    service.changeRole(admin._id, "student", admin),
    { kind: "conflict", details: { code: "SELF_PROTECTED" } },
  );
});
```

**Écrire un test d'intégration** : ajouter un `test(...)` dans `test/api.test.ts` en utilisant `call(méthode, chemin, { token, body })` et `login(email, motDePasse)`. Chaque `test` s'exécute **dans le même processus et sur la même base** que les précédents : utiliser des e-mails **uniques** par test pour ne pas dépendre de l'ordre.

**Quand un test échoue sur « timeout » ou « EADDRINUSE »** : un autre processus garde un port; en intégration le serveur écoute sur le port `0` (libre automatique), donc le plus souvent c'est une base `mongodb-memory-server` qui n'a pas pu télécharger son binaire (premier lancement : connexion internet requise, quelques dizaines de Mo).

---

## 1–2. Analyse statique

| Outil | Commande | Ce que ça attrape |
|---|---|---|
| TypeScript strict | `npm run typecheck` (`tsc --noEmit`) | Fautes de type, `null` non géré, signatures qui ne correspondent plus après un refactor. A servi de filet pendant la réorganisation en dossiers : 39 fichiers déplacés + imports réécrits par script, **0 erreur** ensuite. |
| ESLint | `npm run lint` | Variables inutilisées, imports de type, `console.log` oubliés. |

---

## 3. Tests unitaires de la couche métier (sans base, sans réseau)

**Idée clé** : les services (`UserService`, `AuthService`, `SessionService`) ne dépendent que d'**interfaces** (dépôts, hasher, mail, bus, sessions). Dans les tests on leur donne des **doublures en mémoire** (`test/helpers/fakes.ts`) à la place de MongoDB, bcrypt, SMTP et RabbitMQ. Résultat : des tests qui s'exécutent en **quelques millisecondes** et qui testent **uniquement la règle métier**.

| Fichier | Ce qu'il prouve |
|---|---|
| `test/user.service.test.ts` | Format des matricules (`ENS-2026-0001`) ; création par admin (e-mail du domaine, doublons refusés, mot de passe temporaire envoyé, événement publié) ; l'admin ne peut ni changer son rôle, ni se désactiver, ni se supprimer (`SELF_PROTECTED`) ; `RôleModifié` publié seulement si le rôle change ; réactivation remet le compteur d'échecs à 0 ; changement de mot de passe (ancien requis, différent, fort) ; suppression du téléphone. |
| `test/auth.service.test.ts` | Connexion réussie (jeton, compteur remis à 0) ; échecs successifs → 401 avec compteur puis **423 au seuil** ; compte suspendu reste verrouillé même avec le bon mot de passe ; compte désactivé 403 ; e-mail inconnu 401 **sans révéler** qu'il n'existe pas ; inscription (rôle forcé `student`) ; « mot de passe oublié » n'envoie rien pour compte inconnu/désactivé. |
| `test/session.service.test.ts` | Jeton stocké **haché** ; **rotation** à chaque usage ; **rejeu** d'un ancien jeton ⇒ 401 **et famille entière révoquée** ; deux échanges simultanés du même jeton ⇒ un seul réussit ; jeton inconnu/expiré/révoqué ⇒ même réponse générique ; `closeAll` ne touche que le compte visé. |
| `test/outbox.test.ts` | Enveloppe (champs historiques + `id`/`version`) ; boîte non alimentée sans RabbitMQ ; panne de la boîte ≠ échec métier ; publication **dans l'ordre** ; **bus indisponible** (rien de réservé, reconnexion avec backoff) ; **nack** ⇒ nouvelle tentative avec backoff exponentiel, même `eventId` ; **bail** (un relais planté est repris après expiration, pas avant) ; arrêt propre. |
| `test/platform.test.ts` | Traduction `AppError` → statut HTTP (tableau unique) ; erreurs techniques (JSON invalide 400, trop gros 413, doublon Mongo 409, inconnu 500 **sans fuite**) ; DTO (le rôle envoyé à l'inscription est supprimé, e-mail normalisé, filtres invalides ignorés) ; politiques (domaine, mot de passe fort, regex échappées) ; protection de `/metrics` ; étiquettes de route des métriques. |

**Technique des doublures** : `InMemoryUserRepository` reproduit les règles du vrai dépôt (consommation atomique d'un jeton, `undefined` = suppression d'un champ…). Piège rencontré : une doublure trop permissive masque des bugs ; chaque règle importante de Mongo (atomicité, TTL, bail) y est donc recopiée.

---

## 4. Tests d'intégration HTTP (`test/api.test.ts`)

**Principe** : on lance la **vraie application** (`createApp(container)`), sur un port libre, avec une **vraie MongoDB en mémoire** (`mongodb-memory-server` télécharge et lance un vrai `mongod`), et on l'appelle avec `fetch` comme le ferait le front. Seul l'envoi SMTP échoue (port 1) : c'est voulu, l'API ne doit pas en dépendre.

```ts
before(async () => {
  mongod = await MongoMemoryServer.create();           // vraie base, éphémère
  await mongoose.connect(mongod.getUri());
  const container = buildContainer();                   // même câblage que la production
  await seed(container);                                // permissions + admin
  server = createApp(container).listen(0);              // port libre
});
```

Ce qui est couvert (extraits) :
- Parcours complet : l'admin crée un enseignant, mot de passe temporaire, changement obligatoire, droits des enseignants/étudiants.
- Inscription publique, 5 échecs ⇒ 423, réactivation par l'admin, rôles et permissions (dont le verrou sur `users.*` de l'admin).
- **Contrat JSON** : jamais de `_id`, `passwordHash`, `emailVerified`, `updatedAt` dans les réponses.
- **`/v1` ≡ alias historique** (réponses identiques) ; les sondes ne sont pas versionnées.
- **Pagination** : sans paramètre = comportement historique ; avec `page`/`limit` : pas de doublon entre pages, même ordre que la liste complète ; valeurs invalides ignorées/plafonnées.
- **Sessions** : refresh à rotation, rejeu détecté, `logout`, `logout-all`, **jeton « mort-né »** évité (voir ci-dessous).
- **Observabilité** : `/health`, `/ready`, `x-request-id` (repris ou généré), OpenAPI (corps générés depuis zod), Swagger UI, **métriques par gabarit de route** (le matricule n'apparaît jamais dans une étiquette), `/ready` = 503 `DRAINING` pendant l'arrêt.

**Les 5 tests d'origine n'ont pas vu leurs assertions modifiées** pendant toute la refonte : c'est la preuve que le contrat d'API (et donc le front) n'a pas bougé.

### Piège de timing traité : le jeton « mort-né »
Le claim `iat` d'un JWT est en **secondes**. Si on stocke « jetons valides après » avec la précision de la milliseconde, un utilisateur qui se reconnecte dans la même seconde qu'une révocation reçoit un jeton **déjà invalide**. Solution : tronquer à la seconde et refuser seulement si `iat` est **strictement antérieur**. Le test attend ≥ 1,1 s avant `logout-all` pour que l'ancien jeton soit strictement plus vieux, puis vérifie qu'un jeton émis **tout de suite après** est accepté.

---

## 5. Démarrage réel du serveur compilé

Les tests tournent avec `NODE_ENV=test` (logs coupés, aucune minuterie, base en mémoire) : **le chemin de démarrage réel n'y est jamais exécuté**. On le vérifie donc à part.

1. `npm run build` puis lancement de `dist/server.js` sur un port libre (4099), avec le vrai `.env`, contre la MongoDB locale.
2. `GET /health` ⇒ `UP` ; `GET /ready` ⇒ `UP`, `mongo: up, rabbitmq: disabled` ; `/docs` ⇒ 200 ; `/openapi.json` ⇒ 200.
3. `POST /auth/login` avec les identifiants du `.env` ⇒ jeton, rôle `admin`.
4. Arrêt du processus.

**Erreur commise et corrigée** : j'ai aussi testé un mauvais mot de passe sur le **vrai** compte admin, ce qui a mis son compteur d'échecs à 1 dans la base de développement. Remis à 0 ensuite. Règle retenue : *ne jamais tester d'échecs de connexion sur un vrai compte ; utiliser une base jetable.*

---

## 6. Vérification des traces OpenTelemetry

Objectif : prouver qu'**une requête produit une trace complète** (et pas seulement « ça ne plante pas »). En ESM, si le module d'instrumentation n'est pas chargé **avant** l'application, rien n'est instrumenté et **aucune erreur n'apparaît** ; il faut donc regarder la sortie.

```bash
npm run build
PORT=4098 MONGODB_URI=mongodb://localhost:27017/smartcampus_otel_check \
OTEL_TRACES_EXPORTER=console \
node --env-file=.env --import ./dist/instrumentation.js dist/server.js
curl -X POST localhost:4098/auth/login -H 'Content-Type: application/json' -d '{...}'
```

Observé : un span `POST /auth/login` (HTTP), des spans Express (`middleware - helmetMiddleware`, `request handler - /auth/login`…) et un span **`find users`** (MongoDB, `db.system.name: mongodb`, `db.operation.name: find`) qui **partagent le même `traceId`** avec un parent. Base temporaire supprimée ensuite.

---

## 7. Scénarios réels avec Docker

Docker Desktop doit être démarré. Toutes les ressources créées sont supprimées à la fin.

### 7.1 L'image se construit et le conteneur est correct
```bash
docker build -t smartcampus-user-service .
docker network create sc-net
docker run -d --name smoke-mongo --network sc-net mongo:7
docker run -d --name usvc --network sc-net -p 4097:4001 \
  -e MONGODB_URI=mongodb://smoke-mongo:27017/smoke \
  -e JWT_SECRET=ci-secret-ci-secret-ci-secret-1234 \
  -e FIRST_ADMIN_EMAIL=admin@smartcampus.tn -e FIRST_ADMIN_PASSWORD='Admin2026!' \
  -e METRICS_TOKEN=ci-metrics-token smartcampus-user-service
```
Observé : `/health` UP ; `/ready` UP ; `POST /v1/auth/login` renvoie `token` **et** `refreshToken` ; `/metrics` ⇒ **401 sans jeton, 200 avec** ; processus lancé en **`uid=1000(node)` (non-root)** ; état Docker **`healthy`** (HEALTHCHECK) ; image 347 Mo.

### 7.2 Arrêt progressif (`docker stop`)
Pendant l'arrêt : `/ready` ⇒ **503** (`DRAINING`) et `/health` ⇒ **200**. Logs : `arrêt demandé {signal: SIGTERM, drainMs: 5000}` puis `arrêt terminé`. **Code de sortie 0** (arrêt propre dans l'ordre : serveur → relais → RabbitMQ → MongoDB).

### 7.3 L'outbox contre un vrai RabbitMQ (panne et reprise)
Un petit script jetable déclare une file `e2e-queue` liée à `user.#` et la vide en affichant les messages (propriétés AMQP incluses). Scénario :

| Étape | Action | Observé |
|---|---|---|
| 0 | Le conteneur du service démarre **avant** que RabbitMQ soit prêt | Le service tourne quand même ; `/ready` ⇒ `DEGRADED`, `rabbitmq: down` ; les logs montrent le backoff de reconnexion (4 s, 8 s, 18 s, 32 s, 60 s). Puis, RabbitMQ prêt : `rabbitmq: up` **sans redémarrer le service**. |
| 1 | Bus UP, `POST /users` (alpha) | `201` ; 1 message reçu : clé `user.UtilisateurCréé`, `messageId` = `id` du corps, `type`, **persistant**, `schema-version` 1 ; `outbox_pending_events` = 0 |
| 2 | **`docker stop` RabbitMQ**, `POST /users` (beta, gamma) | **`201` pour les deux** (l'API ne dépend pas du bus) ; `/ready` ⇒ `DEGRADED` ; `outbox_pending_events` = **2** |
| 3 | **`docker start` RabbitMQ** | Le relais se reconnecte seul ; `outbox_pending_events` ⇒ **0** ; la file reçoit **beta puis gamma, dans l'ordre**, avec leurs `messageId` |

**Difficulté d'environnement rencontrée** : sous Docker Desktop pour Windows, `rabbitmq:3-management` plantait au démarrage avec `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces` (problème de droits du cookie Erlang, **sans lien avec le code**). Une fois l'image changée en `rabbitmq:4-management`, il a fallu en plus le lancer directement sous l'utilisateur `rabbitmq` :
```bash
docker run -d --name smoke-rabbit --network sc-net --hostname rabbit-e2e --user rabbitmq -p 5672:5672 rabbitmq:4-management
```
Pendant l'échec de RabbitMQ, le comportement du service (réessais espacés, `DEGRADED`) a d'ailleurs servi de test involontaire de la résilience.

---

## 8. Intégration continue (`.github/workflows/ci.yml`)

À chaque `push` / pull request :

1. **Job `check`** : `npm ci` → lint → typecheck → build → `npm run audit:prod` (échoue sur vulnérabilité haute/critique des dépendances de production) → `npm run test:coverage` (seuils : **lignes 90 %, branches 80 %, fonctions 80 %** ; réel : 95,5 % / 88,3 % / 87,8 %).
2. **Job `docker`** : build de l'image puis **test de fumée** du conteneur contre un service MongoDB (démarrage, `/health`, `/ready`, `/docs`, `/metrics` protégé, connexion admin avec `refreshToken`).

> Limite : ce workflow n'a **pas pu être exécuté sur GitHub** depuis cette machine. Ses commandes (celles du §7.1) ont été validées en local, pas le fichier YAML lui-même. Au premier `push`, regarder l'onglet *Actions*.

`dependabot.yml` propose chaque semaine les mises à jour (npm, Docker, GitHub Actions).

---

## 9. Ce que les vérifications ont réellement trouvé

| Constat | Niveau | Correction |
|---|---|---|
| `typescript-eslint` incompatible avec TypeScript 7 | installation | TypeScript fixé en 5.9 |
| 3 vulnérabilités hautes (`body-parser`, `nodemailer`, `zod`) | audit | `npm audit fix` ; nodemailer 10 ; zod 4 (génération JSON Schema native, `zod-to-json-schema` supprimé) |
| Test attendait des `details` incomplets (`code` manquant, puis compteurs manquants) | unitaire | Le service avait raison, l'attente du test était incomplète : corrigée |
| Logs coupés en test (`NODE_ENV` posé trop tard) | unitaire | `test/setup.ts` chargé par `--import` avant toute importation |
| `OTel` : auto-instrumentations trop lourdes (dizaines de paquets inutiles) | installation | 4 instrumentations ciblées (24 Mo) |
| RabbitMQ 3 ne démarre pas sous Windows (cookie `eacces`) | scénario réel | RabbitMQ 4 + `--user rabbitmq` |
| Mauvais mot de passe testé sur le vrai admin | démarrage réel | compteur remis à 0 ; règle : base jetable |

## 10. Commandes de référence

```bash
npm run check              # lint + typecheck + 47 tests
npm run test:coverage      # idem + seuils de couverture
npm run audit:prod         # vulnérabilités des dépendances de production
npm run build && npm start # version compilée
node --import tsx --import ./test/setup.ts --test test/outbox.test.ts   # un seul fichier de test
```
