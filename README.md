# SmartCampus — user-service

Microservice du module **Utilisateurs** : authentification, comptes, rôles et permissions, historique de connexion.
Node.js 20+ · Express · MongoDB (Mongoose) · JWT · zod · Nodemailer · RabbitMQ (optionnel).

Le contrat d'API suit `src/features/users/README.md` du dépôt front.

## Démarrer

```bash
npm install
cp .env.example .env
docker compose up -d mongo mailpit    # MongoDB + Mailpit (e-mails sur http://localhost:8025)
npm run dev                           # http://localhost:4001  (santé : /health)
npm test                              # tests d'intégration (MongoDB en mémoire, 1er lancement : téléchargement du binaire)
```

Au démarrage, le service crée la matrice de permissions et **le premier administrateur** (`FIRST_ADMIN_*` dans `.env`,
par défaut `admin@smartcampus.tn` / `Admin2026!`) s'il n'existe aucun admin.

## Brancher le front

Dans `.env` du front : `VITE_USE_MOCKS=false`, `VITE_EMAIL_DOMAIN=<EMAIL_DOMAIN>` (identique ici),
et `VITE_API_BASE_URL=http://localhost:4001` (sans Gateway ; `CORS_ORIGINS` doit contenir l'URL du front).
Avec une API Gateway sur `/api`, elle retire le préfixe `/api` avant de router vers ce service.

Pour voir le mot de passe temporaire dans la fenêtre de l'admin sans messagerie : `EXPOSE_TEMP_PASSWORD=true` (dev uniquement).

## Routes

| Route | Accès |
|---|---|
| `POST /auth/login` · `/auth/register` · `/auth/verify-email` · `/auth/resend-activation` · `/auth/forgot-password` · `/auth/reset-password` | public |
| `POST /users` · `GET /users?q=&role=&status=` | admin |
| `GET /users/:id` · `PUT /users/:id` · `GET /users/:id/login-history` | soi-même ou admin |
| `PUT /users/:id/password` · `PUT /users/:id/avatar` | soi-même |
| `PUT /users/:id/role` · `PATCH /users/:id/status` · `DELETE /users/:id` | admin |
| `GET/PUT /roles/permissions` · `GET /login-history` | admin |

Erreurs : `{ message, code?, … }` avec 401 · 403 · 404 · 409 `EMAIL_EXISTS` · 422 `WEAK_PASSWORD`/`SAME_PASSWORD` · 423 `ACCOUNT_LOCKED`.

## Règles métier

- JWT : `sub` (matricule), `name`, `role`. Le rôle et le statut sont **relus en base** à chaque requête.
- 5 échecs de connexion suspendent le compte (423) ; un admin le réactive.
- Inscription publique : toujours `student`. Comptes enseignant/admin : créés par un admin avec mot de passe temporaire envoyé par e-mail (`mustChangePassword`).
- Un admin ne peut pas supprimer, désactiver ni changer le rôle de son propre compte.
- Événements publiés (RabbitMQ, exchange topic `smartcampus.events`, clés `user.UtilisateurCréé` / `user.RôleModifié`) si `RABBITMQ_URL` est défini ; sinon journalisés.

## Organisation

```
src/  app.js · server.js · seed.js · config.js
      routes/ (auth, users, roles, history) · middleware/ (auth, error)
      services/ (accounts, mailer, events, permissions) · models/ · utils/ (validation, security, errors)
test/ api.test.js
```
