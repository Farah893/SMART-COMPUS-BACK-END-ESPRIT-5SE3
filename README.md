# SmartCampus — user-service

Microservice du module **Utilisateurs** : authentification, comptes, rôles et permissions, historique de connexion.
Node.js 20+ · **TypeScript (strict)** · Express · MongoDB (Mongoose) · JWT · zod · Nodemailer · RabbitMQ (optionnel).

Le contrat d'API suit `src/features/users/README.md` du dépôt front.

Documentation : [`docs/GUIDE-INGENIEUR.md`](docs/GUIDE-INGENIEUR.md) (à lire en premier) · [`docs/PRD.md`](docs/PRD.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/INTEGRATION-FRONT-BACK.md`](docs/INTEGRATION-FRONT-BACK.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md) · [`docs/NOTE-EQUIPE.md`](docs/NOTE-EQUIPE.md) (à envoyer aux autres équipes) · [`docs/QUESTIONS-JURY.md`](docs/QUESTIONS-JURY.md) (préparation de la soutenance).

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

## Documentation

| Je veux… | Lire |
|---|---|
| **Travailler en local** : installation, journée type, remises à zéro | `docs/TRAVAIL-EN-LOCAL.md` |
| Comprendre **à quoi sert chaque fichier** | `docs/REFERENCE-FICHIERS.md` |
| **Refaire le service seul**, étape par étape (et ajouter une route/un module/un événement) | `docs/GUIDE-CONSTRUCTION.md` |
| Comprendre **RabbitMQ**, l'outbox et le relais en profondeur | `docs/RABBITMQ-ET-EVENEMENTS.md` |
| Savoir **comment c'est testé** et utiliser les tests | `docs/TESTS-ET-VERIFICATION.md` |
| **Dépanner** (méthode, incidents réels, pannes d'exploitation) | `docs/DEPANNAGE.md` |
| Architecture et décisions | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` |
| Contrat de l'API (interactif) | `http://localhost:4001/docs` |

## Architecture

**Système** : SmartCampus est un ensemble de microservices (voir `docs/ARCHITECTURE.md` §1). **Ce service** : architecture **en couches**, organisée par module métier, avec injection par constructeur (`src/container.ts`). Le découpage du système (microservices) et l'organisation du code (couches) sont deux niveaux distincts ; voir `docs/DECISIONS.md` D2.

```
src/
  server.ts · app.ts · container.ts      démarrage · assemblage Express · câblage des dépendances
  config/                                variables d'environnement (lues et validées une seule fois)
  shared/                                socle partagé par tous les modules
    constants/ errors/ ports/ middleware/ validation/ utils/
  infrastructure/                        accès techniques : database · mail (SMTP) · messaging (RabbitMQ) · security · logging
  modules/                               UN DOSSIER PAR FONCTION MÉTIER, et dans chacun un dossier par type de fichier :
    auth/ users/ roles/ login-history/ health/
      routes/         chemins + middlewares        (user.routes.ts)
      controllers/    couche HTTP                  (user.controller.ts)
      services/       règles métier                (user.service.ts)
      repositories/   accès MongoDB                (user.repository.ts)
      dto/            DTO d'entrée (zod) et de sortie  (user.dto.ts)
      models/         schémas Mongoose             (user.model.ts)
      types/          types du domaine             (user.types.ts)
      middleware/ · constants/                     selon le module (auth.middleware.ts, permission.catalog.ts)
  docs/openapi.ts · bootstrap/seed.ts · scripts/ · types/express.d.ts
test/             unitaires (service + doublures) et intégration (HTTP + MongoDB en mémoire)
```

Règles de dépendance : `routes → controller → service → repository`. Le **controller** ne contient que du HTTP (DTO d'entrée → appel de service → DTO de sortie) ; le **service** porte les règles métier et ne dépend que d'**interfaces** (ports) ; le **repository** est le seul à connaître MongoDB. Les **DTO d'entrée** (zod, types inférés) valident et nettoient les requêtes ; les **DTO de sortie** définissent le JSON exposé (jamais le document Mongoose brut).

## Commandes

```
npm run dev         # développement (tsx, rechargement automatique)
npm run check       # lint + typecheck + tests
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit (mode strict)
npm run build       # compile vers dist/
npm start           # lance dist/server.js
npm test            # tests unitaires + intégration (47)
npm run test:coverage  # idem + seuils de couverture
npm run audit:prod  # vulnérabilités des dépendances de production
npm run seed        # permissions par défaut + administrateur fixe
npm run set-role -- adresse@gmail.com admin
```

Documentation interactive de l'API : `http://localhost:4001/docs` (contrat OpenAPI : `/openapi.json`). Sondes : `/health` (vivacité) et `/ready` (dépendances). Image Docker : `docker build -t smartcampus-user-service .`, ou `docker compose --profile full up -d`.
