# Guide ingénieur : comprendre le user-service de A à Z

Ce guide explique **comment le backend est construit**, fichier par fichier, avec les concepts Node.js, microservice, MongoDB et la liaison avec le front. Lisez-le dans l'ordre : chaque partie s'appuie sur la précédente.

Dossier du projet : `C:\dev\SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE`

---

## 1. Les concepts à connaître

### 1.1 Node.js
Node.js exécute du JavaScript **en dehors du navigateur**. Un serveur Node reste allumé, attend des demandes HTTP, et répond.
- **Asynchrone** : lire une base ou envoyer un e-mail prend du temps. Node ne bloque pas : il utilise `async/await`. Dans le code, chaque `await` veut dire « attends ce résultat sans bloquer les autres utilisateurs ».
- **Modules ES** (`import ... from`) : le `package.json` contient `"type": "module"`, donc chaque fichier importe ce dont il a besoin.
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

**Comment les services se font confiance :** le user-service **signe** un JWT à la connexion avec `JWT_SECRET`. Les autres services **vérifient** ce jeton avec le même secret. Ils savent ainsi qui est l'utilisateur et son rôle, **sans jamais appeler** le user-service.

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
1  Front        fetch POST http://localhost:4001/auth/login   {email, password}
2  app.js       helmet · cors · lecture du JSON · rate limit
3  routes/auth.js   → route POST /login
4  utils/validation.js   zod vérifie le format → sinon 422
5  models/index.js       User.findOne({ email })         ─► MongoDB
6  routes/auth.js        compte inconnu ? suspendu ? désactivé ?
7  utils/security.js     bcrypt compare le mot de passe
8  services/accounts.js  enregistre la tentative (historique)
9  utils/security.js     fabrique le JWT {sub, name, role}
10 Réponse JSON  { token, user }  ─► Front
```

Pour une route **protégée** (par exemple `GET /users`), une étape s'ajoute avant la route : `middleware/auth.js` lit l'en-tête `Authorization: Bearer <token>`, vérifie la signature, **relit le compte en base**, puis laisse passer ou répond 401/403.

**Pourquoi relire le compte en base ?** Un JWT reste valide jusqu'à son expiration. Si on désactive un compte ou qu'on change un rôle, sans relecture le jeton continuerait à marcher. Avec la relecture, le changement est immédiat.

---

## 3. Architecture du code

```
SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE/
├─ .env                  configuration secrète (jamais dans git)
├─ .env.example          modèle de configuration (dans git)
├─ package.json          dépendances et commandes npm
├─ docker-compose.yml    option : MongoDB/Mailpit par Docker (plus nécessaire)
├─ src/
│  ├─ server.js          POINT D'ENTRÉE : démarre tout
│  ├─ app.js             assemble Express (sécurité + routes)
│  ├─ config.js          lit le .env
│  ├─ seed.js            données de départ (permissions, premier admin)
│  ├─ setRole.js         outil : changer un rôle hors interface
│  ├─ routes/            UNE ROUTE = UNE FONCTION DE L'API
│  │   ├─ auth.js        connexion, inscription, mot de passe oublié…
│  │   ├─ users.js       gestion des comptes, profil, photo
│  │   ├─ roles.js       matrice rôles × permissions
│  │   └─ history.js     historique de connexion global
│  ├─ middleware/        code qui s'exécute AVANT les routes
│  │   ├─ auth.js        vérifie le JWT et les droits
│  │   └─ error.js       transforme toute erreur en réponse JSON
│  ├─ services/          logique réutilisable
│  │   ├─ accounts.js    matricules, historique, statistiques
│  │   ├─ permissions.js catalogue des 13 permissions + matrice
│  │   ├─ mailer.js      envoi des e-mails
│  │   ├─ emailTemplates.js  design des e-mails
│  │   └─ events.js      événements de domaine (RabbitMQ)
│  ├─ models/index.js    schémas MongoDB
│  └─ utils/             petites fonctions sans état
│      ├─ validation.js  schémas zod, règles de mot de passe et de domaine
│      ├─ security.js    bcrypt, JWT, mots de passe temporaires, hachages
│      └─ errors.js      classe d'erreur HTTP
├─ test/api.test.js      5 tests d'intégration
└─ docs/                 PRD, ARCHITECTURE, DECISIONS, ce guide
```

**Le principe des couches** : chaque couche ne parle qu'à la suivante.
`routes` (reçoit/répond) → `services` (règle ou travail) → `models` (base).
Les `middleware` filtrent avant les routes. Les `utils` sont des outils sans effet de bord.

---

## 4. Chaque fichier expliqué

### `src/server.js` (démarrage)
```js
await mongoose.connect(config.mongoUri);   // 1. se connecte à MongoDB
await seed();                              // 2. crée permissions + premier admin
await connectBus();                        // 3. RabbitMQ (ignoré si absent)
createApp().listen(config.port, ...);      // 4. ouvre le port 4001
```
Il gère aussi l'arrêt propre (`SIGINT`, `SIGTERM`) : il ferme le serveur puis la base. Si MongoDB est injoignable, le programme s'arrête avec une erreur : c'est voulu, un service sans base ne sert à rien.

### `src/app.js` (assemblage Express)
Express fonctionne comme une **chaîne** : chaque `app.use(...)` est une étape que traverse toute requête, **dans l'ordre**.
1. `helmet()` : en-têtes de sécurité.
2. `cors(...)` : autorise le front à appeler l'API. En développement, tout `localhost:<port>` est accepté ; en production, seulement `CORS_ORIGINS`.
3. `express.json({ limit: "1mb" })` : lit le corps JSON (1 Mo à cause de la photo de profil).
4. `/health` : indique `UP` si MongoDB répond, sinon 503.
5. `/auth` (avec `rateLimit`), `/users`, `/roles`, `/login-history` : les quatre routeurs.
6. `notFoundHandler` puis `errorHandler` : toujours **en dernier**.

### `src/config.js`
Lit toutes les variables d'environnement au même endroit et fournit des valeurs par défaut. **Seul fichier** qui lit `process.env`. En production, refuse de démarrer avec le secret JWT par défaut.

### `.env` (configuration)
| Variable | Rôle |
|---|---|
| `PORT` | Port du service (4001) |
| `MONGODB_URI` | Adresse de la base |
| `JWT_SECRET` | Clé qui signe les jetons (à garder secrète) |
| `JWT_EXPIRES_IN` | Durée de vie du jeton (2h) |
| `EMAIL_DOMAIN` | Domaine d'e-mail accepté (`gmail.com`) |
| `MAX_LOGIN_ATTEMPTS` | Échecs avant verrouillage (5) |
| `FIRST_ADMIN_*` | Identifiants du premier admin créé au démarrage |
| `SMTP_*`, `MAIL_FROM` | Compte Gmail pour envoyer les e-mails |
| `FRONTEND_URL` | Adresse du front, utilisée par les boutons des e-mails |
| `CORS_ORIGINS` | Sites autorisés à appeler l'API |
| `EXPOSE_TEMP_PASSWORD` | Si `true`, renvoie le mot de passe temporaire dans la réponse (développement seulement) |

Le `.env` contient des secrets : il est dans `.gitignore`. Chaque développeur crée le sien avec `.env.example`.

### `src/models/index.js` (la base)
Définit les 5 collections avec Mongoose.
- **`User`** : `_id` = matricule ; `email` unique ; `role` ∈ student/teacher/admin ; `status` ∈ active/inactive/suspended ; `failedAttempts` ; `mustChangePassword` ; `passwordHash` (jamais lu par défaut).
  - Son `toJSON` fait le **pont avec le front** : renomme `_id` en `id`, met les dates en ISO, supprime `passwordHash` et les champs internes. Ainsi le JSON correspond au type TypeScript `UserAccount` du front.
- **`LoginEvent`** : une ligne par tentative de connexion (utilisateur, IP, appareil, succès).
- **`Permission`** : une ligne par couple (rôle, permission) ; index unique `{role, key}`.
- **`Token`** : codes de vérification et jetons de réinitialisation, stockés **hachés**, avec un index TTL qui les supprime à l'expiration.
- **`Counter`** : compteur par rôle pour fabriquer les matricules.

### `src/routes/auth.js` (public, sans JWT)
- **`POST /login`** : suit un ordre précis pour des messages justes.
  1. compte inconnu → 401 ;
  2. suspendu → 423 `ACCOUNT_LOCKED` ;
  3. désactivé → 403 ;
  4. mauvais mot de passe → compteur d'échecs +1, historique, et suspension à 5 ;
  5. succès → compteur à 0, `lastLoginAt`, JWT.
  Les réponses 401/423 incluent `failedAttempts` et `max` : le front affiche « il reste N essais ».
- **`POST /register`** : crée **toujours un étudiant**. Le rôle envoyé par le client est ignoré (zod supprime les champs inconnus). Publie `UtilisateurCréé` et envoie le code de vérification.
- **`POST /verify-email`**, **`/resend-activation`** : code à 6 chiffres, 15 minutes.
- **`POST /forgot-password`** : répond **toujours** « OK », même si le compte n'existe pas, pour ne pas révéler les comptes.
- **`POST /reset-password`** : jeton à usage unique, valable 1 heure.

### `src/routes/users.js` (JWT obligatoire)
Tout le fichier commence par `usersRouter.use(authenticate)`.
- **`POST /`** (admin) : crée un compte, génère un **mot de passe temporaire**, marque `mustChangePassword`, envoie l'e-mail, publie `UtilisateurCréé`.
- **`GET /`** (admin) : filtres `q`, `role`, `status` ; renvoie `{items, stats}`.
- **`GET /:id`, `PUT /:id`** : soi-même ou admin (profil).
- **`PUT /:id/password`** : soi-même ; mauvais actuel → 401, identique → 422, faible → 422.
- **`PUT /:id/avatar`** : soi-même ; la photo est une chaîne image encodée (ou `null`).
- **`PUT /:id/role`** (admin) : publie `RôleModifié`.
- **`PATCH /:id/status`** (admin) : activer remet les échecs à zéro (déverrouille).
- **`DELETE /:id`** (admin).
- **`GET /:id/login-history`** : soi-même ou admin.
- L'admin ne peut ni se supprimer, ni se désactiver, ni changer son propre rôle (409 `SELF_PROTECTED`).

### `src/routes/roles.js` et `src/services/permissions.js`
`PERMISSIONS` est le catalogue des 13 droits (par exemple `academic.manage`, `library.manage`). La matrice rôle × permission est stockée en base. `seedPermissions` utilise `$setOnInsert` : au redémarrage, **il ajoute les droits manquants sans écraser les choix de l'admin**. Les droits `users.*` de l'admin sont verrouillés (403).

### `src/routes/history.js`
Historique de **tous** les comptes (admin). Filtre `?result=success|failure`.

### `src/middleware/auth.js`
- `authenticate` : extrait `Bearer <token>`, vérifie la signature, relit le compte, refuse si introuvable ou non actif. Place le compte dans `req.user`.
- `requireAdmin` : 403 si le rôle n'est pas `admin`.
- `selfOrAdmin` : autorise l'admin, ou la personne dont le matricule est dans l'URL.

### `src/middleware/error.js`
**Un seul endroit** transforme toute erreur en JSON `{ message, code, ... }`. Gère aussi les doublons MongoDB (code 11000 → 409) et les JSON invalides. Le front dépend de ce format.

### `src/utils/validation.js`
Contient les **schémas zod** de chaque requête, `parse()` (renvoie 422 avec le détail des champs), `isInstitutionalEmail` (domaine) et `isStrongPassword` (mêmes règles que le front). **Ne jamais faire confiance au front** : le backend revalide tout.

### `src/utils/security.js`
- `hashPassword`, `verifyPassword` : bcrypt. Le mot de passe n'est jamais stocké en clair.
- `signToken` : JWT contenant `sub` (matricule), `name`, `role`.
- `generateTemporaryPassword` : 10 caractères sans lettres ambiguës, tirage cryptographique.
- `sha256`, `randomToken`, `randomCode` : pour les codes et liens à usage unique.

### `src/utils/errors.js`
Classe `HttpError(status, message, extra)` et des raccourcis (`unauthorized`, `forbidden`, `conflict`…). `wrap()` envoie les erreurs des fonctions `async` vers le gestionnaire d'erreurs.

### `src/services/accounts.js`
`nextId(role)` fabrique le matricule `ETU-2026-0001` avec un `$inc` atomique ; `logLogin` enregistre IP et appareil ; `userStats` compte les comptes par statut.

### `src/services/mailer.js` et `emailTemplates.js`
`emailTemplates.js` produit le HTML aux couleurs de SmartCampus (bleu `#1E3A8A`). `mailer.js` l'envoie via Gmail. **Un échec d'envoi est journalisé mais n'empêche pas** de créer le compte.

### `src/services/events.js`
Publie `UtilisateurCréé` et `RôleModifié`. Toujours écrits dans le terminal, et envoyés à RabbitMQ s'il est configuré. Permet aux autres services de réagir **sans que le user-service les connaisse**.

### `src/seed.js`
Au démarrage : construit les index, crée les permissions par défaut, crée le premier admin s'il n'y en a aucun. **Idempotent** : on peut le relancer sans danger.

### `src/setRole.js`
Outil en ligne de commande : `npm run set-role -- email@gmail.com admin`. Sert pour le premier administrateur ou en dépannage.

### `test/api.test.js`
Lance MongoDB en mémoire et rejoue les parcours : création d'un enseignant, droits, inscription, verrouillage, rôles. Chaque scénario correspond à un critère d'acceptation du PRD. Commande : `npm test`.

---

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
4. Le backend vérifie la signature avec `JWT_SECRET`, relit le compte, applique les droits.

### 5.4 Le contrat d'erreur (ce qui fait fonctionner l'interface)
Le backend renvoie toujours `{ message, code, ... }`. Le front lit directement ces champs :
- 401 avec `failedAttempts` → « il reste N essais » ;
- 423 → bannière « compte suspendu » ;
- 409 `EMAIL_EXISTS` → erreur sur le champ e-mail ;
- 401 `WRONG_PASSWORD`, 422 `SAME_PASSWORD` → erreur sur le bon champ.

### 5.5 CORS
Le front (5173) et le backend (4001) sont deux « origines » différentes : le navigateur bloque la réponse par sécurité, sauf si le backend l'autorise explicitement. C'est le rôle de `cors(...)` dans `app.js`. En développement, il accepte tout `localhost` ; en production, uniquement `CORS_ORIGINS`.

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
2. **Le trajet d'une requête** : `app.js` → middleware → route → validation → modèle → réponse (partie 2).
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
