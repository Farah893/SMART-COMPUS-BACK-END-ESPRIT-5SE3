# Guide ingénieur : comprendre le user-service de A à Z

Ce guide explique **comment le backend est construit**, fichier par fichier, avec les concepts Node.js, microservice, MongoDB et la liaison avec le front. Lisez-le dans l'ordre : chaque partie s'appuie sur la précédente.

Dossier du projet : `C:\dev\SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE`

---

## 1. Les concepts à connaître

### 1.1 Node.js
Node.js exécute du JavaScript **en dehors du navigateur**. Un serveur Node reste allumé, attend des demandes HTTP, et répond.
- **Asynchrone** : lire une base ou envoyer un e-mail prend du temps. Node ne bloque pas : il utilise `async/await`. Dans le code, chaque `await` veut dire « attends ce résultat sans bloquer les autres utilisateurs ».
- **Modules ES** (`import ... from`) : le `package.json` contient `"type": "module"`, donc chaque fichier importe ce dont il a besoin.
- **TypeScript** : le code est écrit en TypeScript (types vérifiés par `npm run typecheck`, compilé vers `dist/` par `npm run build`). En développement, `tsx` exécute directement les fichiers `.ts`.
- **npm** installe des bibliothèques (listées dans `package.json`, stockées dans `node_modules`).
- Chaque bibliothèque a un rôle précis :

| Bibliothèque | Rôle |
|---|---|
| `express` | Reçoit les requêtes HTTP et les dirige vers le bon code |
| `mongoose` | Parle à MongoDB avec des schémas |
| `jsonwebtoken` | Fabrique et vérifie les jetons JWT |
| `bcryptjs` | Hache les mots de passe |
| `zod` | Valide les données reçues |
| `nodemailer` | Envoie les e-mails (Gmail) |
| `helmet` | Ajoute des en-têtes de sécurité HTTP |
| `cors` | Autorise le front (autre adresse) à appeler l'API |
| `express-rate-limit` | Limite le nombre de requêtes (anti force brute) |
| `morgan` | Journal des requêtes dans le terminal |
| `amqplib` | Publie des événements sur RabbitMQ (optionnel) |

### 1.2 Qu'est-ce qu'un microservice ?
Une application classique (« monolithe ») met tout dans un seul programme et une seule base. Un **microservice** est un petit programme **autonome** qui gère **un seul métier**.

Dans SmartCampus : 6 modules = 6 microservices. Le nôtre, le **user-service**, gère uniquement : comptes, connexion, rôles, permissions, historique de connexion.

Les règles d'un vrai microservice, et comment elles sont appliquées ici :

| Règle | Application dans le projet |
|---|---|
| Un service = un métier | Le user-service ne connaît ni les cours ni les livres |
| Une base de données par service | Sa base `smartcampus_users` n'est lue que par lui |
| Démarre et s'arrête seul | Son propre `package.json`, son propre `.env`, son propre dépôt git |
| Parle par API et événements | Routes HTTP (`/auth`, `/users`…) et événements `UtilisateurCréé`, `RôleModifié` |
| Sans état (stateless) | Aucune session en mémoire : l'identité est dans le JWT, donc on peut lancer plusieurs copies |
| Surveillable | `GET /health` indique si le service et sa base fonctionnent |

**Comment les services se font confiance :** le user-service **signe** un JWT à la connexion avec sa **clé privée** (RS256 ; en développement seulement, un secret `JWT_SECRET` en HS256). Les autres services **vérifient** ce jeton avec la **clé publique** téléchargée sur `/.well-known/jwks.json` (aucun secret partagé). Ils savent ainsi qui est l'utilisateur et son rôle, **sans jamais appeler** le user-service.

### 1.3 MongoDB
MongoDB est une base **orientée documents** : au lieu de tables et de lignes, on stocke des documents JSON dans des **collections**.

| SQL | MongoDB | Dans le projet |
|---|---|---|
| Base | Base | `smartcampus_users` |
| Table | Collection | `users`, `loginevents`, `permissions`, `tokens`, `counters` |
| Ligne | Document | Un compte utilisateur |
| Colonne | Champ | `email`, `role`, `status`… |
| Clé primaire | `_id` | Pour `users`, c'est le matricule (`ETU-2026-0001`) |

Notions utilisées :
- **Schéma Mongoose** : MongoDB est libre, Mongoose impose une structure (types, valeurs permises, valeurs par défaut).
- **Index unique** : MongoDB refuse un doublon. L'e-mail est unique : impossible de créer deux comptes avec la même adresse, même si deux demandes arrivent en même temps.
- **Index TTL** : MongoDB supprime lui-même les documents expirés. Les codes de vérification et liens de réinitialisation disparaissent seuls.
- **`$inc` atomique** : sert à fabriquer les matricules sans doublon, même avec plusieurs demandes simultanées.
- **`select: false`** : le champ `passwordHash` n'est jamais lu, sauf demande explicite.

Où est stockée la base : MongoDB est installé sur le PC comme **service Windows** et écoute sur le port `27017`. L'adresse est dans `.env` : `MONGODB_URI=mongodb://localhost:27017/smartcampus_users`.

---

## 2. Le trajet d'une requête (à comprendre en priorité)

Exemple : l'utilisateur clique sur **Se connecter**.

```
1  Front            fetch POST http://localhost:4001/auth/login   {email, password}
2  app.ts           helmet · journal (id de requête) · cors · lecture du JSON · rate limit
3  auth.routes.ts   route POST /login
4  validate.ts      le DTO d'entrée (zod, auth.dto.ts) vérifie le format → sinon 422
5  auth.controller  passe le DTO et le contexte (IP, navigateur) au service
6  auth.service     compte inconnu ? suspendu ? désactivé ?          (règles métier)
7  user.repository  findByEmailWithPassword                          ─► MongoDB
8  password hasher  bcrypt compare le mot de passe
9  auth.service     échec : compteur +1 (atomique), suspension au seuil ; succès : remise à zéro
10 login-history    enregistre la tentative (IP, appareil)
11 token-service    fabrique le JWT {sub, name, role}
12 auth.dto.ts      toLoginResponse : seul le JSON voulu sort
   Réponse JSON  { token, user }  ─► Front
```

Pour une route **protégée** (par exemple `GET /users`), une étape s'ajoute avant la route : `middleware/auth.middleware.ts` lit l'en-tête `Authorization: Bearer <token>`, vérifie la signature, **relit le compte en base**, puis laisse passer ou répond 401/403.

**Pourquoi relire le compte en base ?** Un JWT reste valide jusqu'à son expiration. Si on désactive un compte ou qu'on change un rôle, sans relecture le jeton continuerait à marcher. Avec la relecture, le changement est immédiat.

---

## 3. Architecture du code

> **Deux niveaux à ne pas confondre.** Les **microservices** décrivent comment on découpe le *système* (un service par métier, sa propre base, communication par API et événements : voir 1.2). L'**architecture en couches** décrit comment on organise le *code à l'intérieur d'un service*. Chaque service peut choisir sa propre structure interne : couches pour les services simples (comme celui-ci), hexagonal/clean pour les services au cœur métier riche (voir `docs/DECISIONS.md`, D2).

```
SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE/
├─ .env / .env.example     configuration (le .env n'est jamais dans git)
├─ package.json            dépendances et commandes (dev, build, check, test…)
├─ tsconfig*.json          TypeScript strict (typecheck) et compilation vers dist/
├─ Dockerfile · docker-compose.yml · .github/workflows/ci.yml
├─ src/
│  ├─ server.ts            POINT D'ENTRÉE : démarre tout, arrêt propre
│  ├─ app.ts               assemble Express (sécurité, journal, routes, erreurs)
│  ├─ container.ts         câble les couches (qui dépend de qui)
│  ├─ config/              lit et valide le .env
│  ├─ shared/              socle partagé : erreurs, ports, middlewares, validation, constantes
│  ├─ infrastructure/      accès techniques : MongoDB, e-mail, RabbitMQ, bcrypt/JWT, logs
│  ├─ modules/             UN DOSSIER PAR FONCTION MÉTIER, avec un sous-dossier par type de fichier
│  │                        (routes/ controllers/ services/ repositories/ dto/ models/ types/)
│  │   ├─ auth/            connexion, inscription, mot de passe oublié
│  │   ├─ users/           comptes, profil, rôle, statut, photo
│  │   ├─ roles/           matrice rôles × permissions
│  │   ├─ login-history/   historique de connexion
│  │   └─ health/          sondes /health et /ready
│  ├─ docs/openapi.ts      contrat de l'API (page /docs)
│  ├─ bootstrap/seed.ts    données de départ ; scripts/ : outils en ligne de commande
│  └─ types/               types Express (req.user, req.dto)
├─ test/                   tests unitaires (sans base) et d'intégration (HTTP + MongoDB en mémoire)
└─ docs/                   PRD, ARCHITECTURE, DECISIONS, ce guide
```

**Le principe des couches** (dans chaque module) : chaque couche ne parle qu'à la suivante.

```
routes ─► controller ─► service ─► repository ─► MongoDB
 chemins    HTTP        règles      accès aux
 + garde    seulement   métier      données
```

- **DTO d'entrée** (`dto/*.dto.ts`, zod) : valident et nettoient ce qui arrive. **DTO de sortie** : décident de ce qui sort (jamais le mot de passe haché ni `_id`).
- Le **service** ne connaît ni Express ni MongoDB : il se teste sans base.
- Les **erreurs** disent ce qui s'est passé (`conflict`, `locked`…) ; un seul endroit les traduit en code HTTP.

---

## 4. Chaque fichier expliqué

La description détaillée, fichier par fichier, est dans **`docs/ARCHITECTURE.md` (section 4)** ; elle est tenue à jour avec le code. Repères pour s'orienter :

| Je cherche… | Fichier |
|---|---|
| Ce qui se passe au démarrage | `src/server.ts` |
| L'ordre des protections HTTP | `src/app.ts` |
| Qui dépend de qui | `src/container.ts` |
| La connexion et ses règles (423, 403, compteur) | `src/modules/auth/services/auth.service.ts` |
| Les règles sur les comptes (auto-protection de l'admin, matricules) | `src/modules/users/services/user.service.ts` |
| Le JSON exposé au front | `src/modules/users/dto/user.dto.ts`, `src/modules/auth/dto/auth.dto.ts` |
| Les droits (JWT, admin, soi-même) | `src/modules/auth/middleware/auth.middleware.ts` |
| La traduction erreur → code HTTP | `src/shared/middleware/error-handler.ts` |
| Les variables d'environnement | `src/config/index.ts` et `.env.example` |
| Les permissions par défaut | `src/modules/roles/constants/permission.catalog.ts` |
| Les e-mails | `src/infrastructure/mail/` |
| Les événements RabbitMQ | `src/infrastructure/messaging/event-bus.ts` |
| La documentation interactive | `http://localhost:4001/docs` |

### `.env` (configuration)
| Variable | Rôle |
|---|---|
| `PORT` | Port du service (4001) |
| `MONGODB_URI` | Adresse de la base |
| `JWT_PRIVATE_KEY_FILE` / `JWT_SECRET` | Clé privée RSA qui signe les jetons en production (RS256, `npm run keys:generate`) / secret de développement (HS256). À garder secret |
| `JWT_EXPIRES_IN` | Durée de vie du jeton (2h) |
| `EMAIL_DOMAIN` | Domaine d'e-mail accepté (`gmail.com`) |
| `MAX_LOGIN_ATTEMPTS` | Échecs avant verrouillage (5) |
| `FIRST_ADMIN_*` | Identifiants du premier admin créé au démarrage |
| `SMTP_*`, `MAIL_FROM` | Compte Gmail pour envoyer les e-mails |
| `FRONTEND_URL` | Adresse du front, utilisée par les boutons des e-mails |
| `CORS_ORIGINS` | Sites autorisés à appeler l'API |
| `EXPOSE_TEMP_PASSWORD` | Si `true`, renvoie le mot de passe temporaire dans la réponse (développement seulement) |

Le `.env` contient des secrets : il est dans `.gitignore`. Chaque développeur crée le sien avec `.env.example`.

## 5. Comment le backend et le front sont connectés

### 5.1 Le principe
Ce sont **deux programmes séparés** qui se parlent en **HTTP + JSON** :

```
Navigateur (React, port 5173)  ──fetch──►  Backend Node (port 4001)  ──►  MongoDB (27017)
        ◄──────── JSON ──────────────────────────┘
```

### 5.2 Les 4 points de contact

**① L'adresse de l'API** : fichier `.env` du **front** :
```
VITE_USE_MOCKS=false                     # false = utiliser le vrai backend
VITE_API_BASE_URL=http://localhost:4001  # où se trouve le backend
VITE_EMAIL_DOMAIN=gmail.com              # identique à EMAIL_DOMAIN du backend
```

**② Le client unique** : `src/api/client.ts` (front). Toutes les requêtes passent par lui :
- il ajoute l'en-tête `Authorization: Bearer <JWT>` ;
- si la réponse n'est pas OK, il crée une `ApiError(status, message, details)` où `details` est le **corps JSON de l'erreur** ;
- en mode mock, il appelle une fausse fonction au lieu du réseau.

**③ Les fonctions d'API** : `src/features/users/api/index.ts` (front). Chaque fonction correspond à une route du backend :
```ts
export const listUsers = (filters, signal) =>
  api.get<UserList>(`/users${query({ q, role, status })}`, { signal, mock: ... });
```
Le contrat (noms de champs, codes d'erreur) est dans `src/features/users/README.md`. **Le backend a été écrit pour respecter ce contrat.**

**④ Le routage par module** : `VITE_REAL_API_PREFIXES` (par défaut `/auth,/users,/roles,/login-history`). Les routes listées vont au vrai backend ; les autres modules gardent leurs données fictives tant que leur service n'existe pas. Quand un ami a terminé, on ajoute ses préfixes dans cette variable.

### 5.3 Le cycle de vie du JWT
1. `POST /auth/login` → le backend renvoie `{ token, user }`.
2. Le front garde le jeton dans `localStorage` (`smartcampus.jwt`) et le profil dans la session.
3. Chaque requête suivante envoie `Authorization: Bearer <jeton>`.
4. Le backend vérifie la signature (clé publique en RS256, secret en développement), relit le compte, applique les droits.

### 5.4 Le contrat d'erreur (ce qui fait fonctionner l'interface)
Le backend renvoie toujours `{ message, code, ... }`. Le front lit directement ces champs :
- 401 avec `failedAttempts` → « il reste N essais » ;
- 423 → bannière « compte suspendu » ;
- 409 `EMAIL_EXISTS` → erreur sur le champ e-mail ;
- 401 `WRONG_PASSWORD`, 422 `SAME_PASSWORD` → erreur sur le bon champ.

### 5.5 CORS
Le front (5173) et le backend (4001) sont deux « origines » différentes : le navigateur bloque la réponse par sécurité, sauf si le backend l'autorise explicitement. C'est le rôle de `cors(...)` dans `app.ts`. En développement, il accepte tout `localhost` ; en production, uniquement `CORS_ORIGINS`.

### 5.6 Corrections faites pour que cela fonctionne
| Problème | Fichier du front | Correction |
|---|---|---|
| Le vrai JWT était écrasé par un faux | `auth/AuthContext.tsx` | Faux jeton seulement en mode mock |
| Les filtres de recherche n'étaient pas envoyés | `features/users/api/index.ts` | Ajout de `query()` |
| Les autres modules cassaient (pas de backend) | `api/client.ts` | Routage par préfixes (④) |
| L'interface « démo » restait visible | `LoginPage.tsx`, `TopBar.tsx`, `VerifyEmailPage.tsx` | Affichée seulement en mode mock |

---

## 6. Lancer et vérifier

```bash
# Terminal 1 : backend
cd C:\dev\SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE
npm run dev                    # http://localhost:4001  (santé : /health)

# Terminal 2 : frontend
cd C:\dev\SMART-COMPUS-ESPRIT-5SE3-FRONT-END
npm run dev                    # http://localhost:5173

# Tests du backend
npm test
```
Prérequis : le service Windows **MongoDB** doit tourner (port 27017).

---

## 7. Ce qu'un ingénieur doit pouvoir expliquer

1. **Pourquoi un microservice** : un métier, une base, un déploiement indépendant.
2. **Le trajet d'une requête** : `app.ts` → middleware → route → validation → controller → service → repository → réponse (partie 2).
3. **Le rôle du JWT** : l'identité voyage avec la requête ; le backend le signe, les autres services le vérifient. Et pourquoi on relit le compte en base.
4. **Pourquoi bcrypt et pas un chiffrement** : le hachage est à sens unique ; même la base volée ne livre pas les mots de passe.
5. **Pourquoi valider côté backend** : le front peut être contourné.
6. **Pourquoi la réponse de `forgot-password` est toujours « OK »** : empêcher de deviner quels e-mails existent.
7. **Les index MongoDB** : unicité de l'e-mail, expiration automatique des jetons, matricule atomique.
8. **Comment le front sait quoi afficher** : le contrat d'erreur `{message, code, ...}`.
9. **Les limites assumées** : pas de refresh token, pas d'outbox pour les événements, pagination absente de `GET /users`, secret JWT partagé en HS256.

### Limites actuelles à connaître
- Les routes contiennent encore une partie de la logique métier ; au-delà d'un certain volume il faudrait des services dédiés par cas d'usage.
- Un événement peut être perdu si RabbitMQ est absent (pas de pattern outbox).
- Le lien des e-mails pointe vers `localhost` tant que le front n'est pas déployé.
- Seul le user-service est réel : les 5 autres modules du front utilisent des données fictives.
