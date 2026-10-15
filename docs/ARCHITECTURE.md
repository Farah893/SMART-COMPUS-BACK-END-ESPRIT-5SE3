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

## 2. Architecture interne du user-service

Architecture en **couches**, simple et lisible :

```
HTTP ─► middleware (sécurité, auth) ─► routes (contrôleurs) ─► services (métier/infra) ─► models (MongoDB)
                                                │
                                                └─► utils (validation zod, hachage, JWT, erreurs)
```

| Couche | Dossier | Rôle |
|---|---|---|
| Entrée | `app.js`, `server.js` | Assemblent Express, démarrent MongoDB, le seed, le bus, le serveur |
| Middleware | `middleware/` | Authentification, droits, gestion centrale des erreurs |
| Routes | `routes/` | Une route = une fonction de l'API du front ; valide, applique la règle, répond |
| Services | `services/` | Matricules et historique, e-mails, événements, permissions |
| Modèles | `models/index.js` | Schémas Mongoose (la « base de données ») |
| Utilitaires | `utils/` | Validation, sécurité, erreurs |

**Limite assumée** : les routes contiennent encore une partie de la logique métier. Si le service grossit, extraire un `UserService` (une classe par cas d'usage) et ajouter des tests unitaires.

## 3. Base de données MongoDB

Base `smartcampus_users`, 5 collections :

| Collection | Contenu | Points importants |
|---|---|---|
| `users` | Comptes | `_id` = matricule (`ETU-2026-0001`) ; `email` unique ; `passwordHash` en `select:false` (jamais lu sauf demande explicite) ; index sur `role` et `status` |
| `loginevents` | Une ligne par tentative de connexion | `userId`, `ip`, `device`, `success`, `date` |
| `permissions` | Une ligne par couple (rôle, permission) | Index unique `{role, key}` |
| `tokens` | Codes de vérification et jetons de réinitialisation | Valeur **hachée** ; index TTL `expiresAt` : MongoDB supprime les expirés |
| `counters` | Séquences par rôle | `findOneAndUpdate + $inc` : incrément atomique, donc pas de matricule en double |

## 4. Les fichiers importants, un par un

### `src/server.js`
Point de démarrage : connecte MongoDB, exécute `seed()`, connecte RabbitMQ (optionnel), écoute sur le port. Sur SIGINT/SIGTERM, ferme le serveur puis MongoDB (arrêt propre).

### `src/app.js`
Construit l'application Express. Ordre voulu : `helmet` (en-têtes de sécurité) → `cors` (origines autorisées) → `express.json` (limite 1 Mo pour la photo) → `/health` → routeurs → 404 → gestionnaire d'erreurs.
`trust proxy` : derrière la Gateway, `req.ip` donne la vraie IP du client (historique de connexion).
Le `rateLimit` n'est appliqué qu'à `/auth` : limite la force brute (100 requêtes / 15 min / IP) en plus du verrouillage par compte.

### `src/config.js`
Lit toutes les variables d'environnement une seule fois. Refuse de démarrer en production avec le secret JWT par défaut.

### `src/utils/validation.js`
Définit les schémas **zod** de chaque corps de requête et `parse()` qui renvoie un 422 `VALIDATION_ERROR`. Détail clé : `schemas.register` ne déclare pas `role` ; zod supprime les clés inconnues, donc **un client ne peut pas s'inscrire comme admin**. Contient aussi `isInstitutionalEmail` (domaine) et `isStrongPassword` (mêmes règles que le front).

### `src/utils/security.js`
- `hashPassword` / `verifyPassword` : bcrypt (coût 10).
- `signToken` : JWT avec `sub` (matricule), `name`, `role` — le contrat attendu par le front et les autres services.
- `generateTemporaryPassword` : 10 caractères sans lettres ambiguës (`0/O`, `1/l/I`), au moins une majuscule/minuscule/chiffre, tirage par `crypto.randomInt` (cryptographiquement sûr).
- `sha256`, `randomToken`, `randomCode` : pour les codes et liens à usage unique.

### `src/utils/errors.js`
`HttpError(status, message, extra)` et les fabriques `unauthorized`, `forbidden`, `conflict`… `wrap()` envoie les erreurs des handlers async à Express (sans lui, une promesse rejetée planterait la requête).

### `src/middleware/auth.js`
- `authenticate` : extrait `Bearer`, vérifie la signature, puis **relit le compte** en base. Un compte supprimé/désactivé/suspendu est refusé (401) même avec un jeton encore valide. `req.user` contient le compte à jour.
- `requireAdmin` : 403 si le rôle (relu en base) n'est pas `admin`.
- `selfOrAdmin` : autorise l'admin ou le propriétaire de la ressource (`:id` = matricule du jeton).

### `src/middleware/error.js`
Un seul endroit transforme les erreurs en `{message, code, …}`. Convertit aussi l'erreur MongoDB `11000` (doublon d'e-mail, course entre deux inscriptions simultanées) en 409.

### `src/models/index.js`
Schémas Mongoose. Le `toJSON` du modèle `User` est la **frontière avec le front** : il renomme `_id` en `id`, convertit les dates en ISO, retire `passwordHash`, `__v`, `emailVerified`, et n'expose `mustChangePassword` que s'il est vrai. C'est ce qui garantit que le JSON correspond au type TypeScript `UserAccount`.

### `src/routes/auth.js` (public)
- **login** : ordre voulu — inconnu → 401 ; suspendu → 423 ; inactif → 403 ; mauvais mot de passe → compteur +1, historique, suspension à 5 (423) sinon 401 avec `failedAttempts` et `max` (le front affiche « il reste N essais »). Succès → compteur à 0, `lastLoginAt`, historique, JWT.
- **register** : vérifie domaine, force du mot de passe, unicité ; crée **toujours un student** ; publie `UtilisateurCréé` ; envoie le code de vérification.
- **verify-email / resend-activation** : compare le hash du code, supprime le jeton (usage unique).
- **forgot-password** : répond toujours `{ok:true}` pour ne pas révéler quels e-mails existent ; n'envoie que si le compte existe et n'est pas désactivé.
- **reset-password** : valide le jeton haché, change le mot de passe, lève `mustChangePassword`.

### `src/routes/users.js` (JWT requis)
Tout le routeur passe par `authenticate`.
- `POST /` (admin) : génère le mot de passe temporaire, crée le compte avec `mustChangePassword`, publie `UtilisateurCréé`, envoie l'e-mail. `demoTemporaryPassword` n'est renvoyé que si `EXPOSE_TEMP_PASSWORD=true` (développement).
- `GET /` (admin) : filtres `q` (regex **échappée**, insensible à la casse), `role`, `status` ; renvoie `{items, stats}` (stats calculées par agrégation sur tous les comptes, pas sur le résultat filtré).
- `GET/PUT /:id` : soi-même ou admin.
- `PUT /:id/password` : seulement soi-même ; vérifie l'actuel (401), différent (422), fort (422).
- `PUT /:id/avatar` : seulement soi-même ; accepte `null` pour supprimer.
- `PUT /:id/role` : admin ; publie `RôleModifié` seulement si le rôle change ; `notSelf` empêche l'auto-modification.
- `PATCH /:id/status` : activer remet `failedAttempts` à 0 (déverrouille un compte suspendu).
- `DELETE /:id` : 204 ; interdit sur soi-même.

### `src/routes/roles.js` et `src/services/permissions.js`
`PERMISSIONS` est le catalogue (12 permissions). `seedPermissions` insère les valeurs par défaut avec `$setOnInsert` : au redémarrage, **les modifications de l'admin ne sont pas écrasées**. `permissionMatrix` reconstruit `matrix[role][clé]` en initialisant tout à `false`.

### `src/routes/history.js`
`GET /login-history` : tous les événements (admin). Les événements d'un utilisateur sont dans `users.js`.

### `src/services/accounts.js`
`nextId(role)` : matricule atomique `PRÉFIXE-ANNÉE-NNNN`. `logLogin` : enregistre IP et appareil (déduit du User-Agent). `userStats` : agrégation par statut.

### `src/services/mailer.js`
Nodemailer. **Un échec d'envoi est journalisé mais ne fait pas échouer** la création du compte : l'admin peut toujours réinitialiser plus tard.

### `src/services/events.js`
`publishEvent(name, payload)` journalise toujours, et publie sur RabbitMQ (exchange topic, clé `user.<nom>`, message persistant) si connecté. Si le bus est absent ou tombe, le service continue de fonctionner.

### `src/seed.js`
Idempotent : permissions par défaut + **premier administrateur** s'il n'existe aucun admin (variables `FIRST_ADMIN_*`). Aucun écran ne crée le premier admin, comme l'exige le README du module.

### `test/api.test.js`
Démarre une MongoDB en mémoire, lance l'application sur un port libre et rejoue les parcours d'acceptation du PRD via HTTP réel.

## 5. Sécurité : résumé des choix

| Risque | Parade |
|---|---|
| Mots de passe volés en base | bcrypt ; hash jamais exposé (`select:false` + `toJSON`) |
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
npm test                                # 5 tests d'intégration (MongoDB en mémoire)
```
