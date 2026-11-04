# Passation : SmartCampus, module Utilisateurs

Dernière mise à jour : 2 novembre 2026. Ce document permet à une personne qui reprend le projet de savoir **où l'on en est, comment lancer, et quoi faire ensuite**. Les détails techniques sont dans `docs/`.

---

## 1. Où en est le projet

| Élément | État |
|---|---|
| **user-service** (backend Node.js **TypeScript** + MongoDB) | Terminé, testé, durci pour la production (voir « Niveau production » ci-dessous). **Non commité** : voir §8, point 0 |
| **Front React** | Branché au user-service ; fusionné dans `main` (PR n°1) |
| Les 5 autres modules (académique, ressources, résidences, vie étudiante, bibliothèque) | **Front seulement, avec données fictives**. Leurs microservices n'existent pas encore |
| API Gateway | **Non faite** : en développement, le front appelle directement le user-service |
| Déploiement | Non fait : tout tourne en local |

**Vérifié :** 74 tests passent (`npm run check` : lint, typecheck et tests ; couverture 96,9 % lignes / 88,2 % branches) ; `npm audit` des dépendances de production : 0 vulnérabilité ; le service tourne sur une vraie MongoDB ; les e-mails (compte, code, réinitialisation) partent par Gmail ; `typecheck` et `build` du front passent.
**Vérifié en conditions réelles (Docker Desktop, 2 nov. 2026) :** l'image Docker se construit ; le conteneur tourne en non-root et est `healthy` ; `/metrics` répond 401 sans jeton et 200 avec ; arrêt progressif (`/ready` 503 pendant que `/health` reste 200, sortie code 0) ; **outbox contre un vrai RabbitMQ 4** : livraison avec les bonnes propriétés AMQP, panne du courtier (l'API répond 201, 2 événements en attente), redémarrage (reconnexion automatique, les 2 événements livrés dans l'ordre) ; traces OpenTelemetry (un span HTTP et un span MongoDB partagent le même `traceId`).
**Non vérifié :** parcours complet cliqué dans le navigateur par une autre personne, la Gateway, tout déploiement, et le **workflow GitHub Actions** (`.github/workflows/ci.yml` : ses commandes ont été validées en local, jamais exécuté sur GitHub).

### Niveau production du user-service (ajouté le 2 novembre 2026)

| Sujet | Ce qui est en place | Détail |
|---|---|---|
| Architecture | Couches par module (`routes → controllers → services → repositories`), dossiers par type de fichier, DTO d'entrée/sortie, injection par constructeur, `shared/` | `docs/ARCHITECTURE.md`, `docs/REFERENCE-FICHIERS.md`, décision D2 |
| API | `/v1` **et** routes historiques (identiques), pagination additive (`page`, `limit`, `total`), OpenAPI sur `/docs` | décision D3 |
| Sessions | Jeton de rafraîchissement à rotation, rejeu détecté (famille révoquée), `logout`, `logout-all`, révocation des jetons d'accès | décision D4 |
| Événements | Boîte d'envoi (outbox) + relais vers RabbitMQ (confirmations, reconnexion, backoff, bail), enveloppe versionnée avec `id` | `docs/RABBITMQ-ET-EVENEMENTS.md`, décision D5 |
| Exploitation | Logs JSON avec `x-request-id`, métriques Prometheus (`/metrics`), traces OpenTelemetry (désactivées par défaut), `/health` + `/ready`, arrêt progressif, config validée au démarrage | décision D6, `docs/DEPANNAGE.md` |
| Livraison | Dockerfile 3 étapes non-root, `docker-compose` (profil `full`), CI, Dependabot, audit, seuils de couverture | `docs/GUIDE-CONSTRUCTION.md` étape 11 |

### Ce qui n'est PAS complet (à ne pas présenter comme fait)

1. **Rien n'est commité.** L'index git est à moitié préparé (renommages vers des `.js` supprimés, nouveaux `.ts` non suivis). **Ne pas faire `git commit -a`** : cela enregistrerait les suppressions sans le nouveau code. Préparer avec `git add -A -- . ":!qc" ":!query"`.
2. **La CI GitHub n'a jamais tourné.** Regarder l'onglet *Actions* au premier `push`.
3. **Audit de sécurité et durcissement** (4 nov. 2026) : 24 constats d'un audit indépendant, tous traités ou documentés comme résiduels dans `docs/SECURITE.md` (verrouillage temporaire, connexion sans fuite d'information, e-mail vérifié obligatoire, limiteurs par usage, démarrage refusé en production avec une config faible, **RS256 + JWKS**, etc.). **Skill `security`** enregistrée (`~/.claude/skills/security`) : méthode réutilisable. **Pas encore commité.** En production : `npm run keys:generate`, puis `JWT_PRIVATE_KEY_FILE` (ou `JWT_PRIVATE_KEY` en base64) et un `FIRST_ADMIN_PASSWORD` fort ; sinon le service refuse de démarrer.
3b. **Session par cookies `httpOnly`** (4 nov. 2026) : le front envoie `X-Auth-Mode: cookie` ; les jetons ne sont plus dans le corps ni dans `localStorage`. Testé en local (52 tests back, 19 tests front, scénario complet contre un vrai service). **Pas encore commité côté back.** À décider : la Gateway doit relayer le cookie `sc_access` en `Authorization: Bearer` pour les autres services (voir `docs/INTEGRATION-FRONT-BACK.md`). Le front n'utilise toujours pas `/v1` ni la pagination.
4. **Outbox, limite connue** : sans réplica MongoDB, l'écriture de l'événement n'est pas atomique avec celle du compte (un plantage entre les deux perd l'événement ; fenêtre de quelques millisecondes). Les consommateurs doivent dédupliquer sur `messageId` ; l'ordre n'est garanti qu'au sein d'une instance.
5. **Révocation des jetons : seulement dans le user-service.** Les autres services vérifient la signature seule et acceptent un JWT révoqué jusqu'à son expiration (décision D4).
6. **Non fait, volontairement** : manifestes Kubernetes, règles d'alerte Prometheus (alerte conseillée : `outbox_pending_events` > 0 pendant plus de 5 min), file « dead-letter » côté consommateurs. Ils dépendent de l'hébergement et des autres services.
7. **`qc` et `query`** (racine du dépôt) : deux fichiers non suivis dont l'origine est inconnue. Non touchés.

## 2. Dépôts et branches

**Une seule branche par dépôt** (décision du 4 novembre 2026, plus de `main`) :

| Dépôt | Adresse | Branche unique (et par défaut) |
|---|---|---|
| Front | `https://github.com/Farah893/SMART-COMPUS-ESPRIT-5SE3-FRONT-END` | `FarahFront` |
| Backend (user-service) | `https://github.com/Farah893/SMART-COMPUS-BACK-END-ESPRIT-5SE3` | `FarahBack` |

Dependabot est **désactivé** (`.github/dependabot.yml`, `open-pull-requests-limit: 0`) : il créait une branche et une pull request par dépendance. Le garde-fou `npm audit --omit=dev` reste dans la CI. Pour le réactiver, voir le commentaire en tête du fichier.

Dossiers sur le PC de Farah : `C:\dev\SMART-COMPUS-ESPRIT-5SE3-FRONT-END` et `C:\dev\SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE`.

## 3. Lancer le projet

**Prérequis :** Node.js 20.6+ et **MongoDB** installé comme service Windows (port 27017). Docker n'est **pas** nécessaire pour développer ; il sert seulement à construire l'image, lancer RabbitMQ en local (`docker compose up -d rabbitmq`) ou refaire les vérifications de `docs/TESTS-ET-VERIFICATION.md` §7.

```bash
# Backend
cd SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE
npm install
cp .env.example .env        # puis remplir le .env (voir §4)
npm run dev                 # http://localhost:4001   santé : /health

# Frontend (autre terminal)
cd SMART-COMPUS-ESPRIT-5SE3-FRONT-END
npm install
cp .env.example .env        # puis régler les 3 variables (voir §4)
npm run dev                 # http://localhost:5173
```
Tests du backend : `npm test` (ou `npm run check` pour lint + typecheck + tests). API documentée sur `http://localhost:4001/docs`. Un seul `npm run dev` par projet à la fois (sinon le port est occupé).

## 4. Configuration (les `.env` ne sont JAMAIS dans git)

**Backend `.env`** : à compléter à partir de `.env.example`.
| Variable | À mettre |
|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017/smartcampus_users` |
| `JWT_SECRET` | Développement seulement (HS256). **En production : RS256** : `npm run keys:generate` puis `JWT_PRIVATE_KEY_FILE=keys/jwt-private.pem`. Les autres services vérifient avec `/.well-known/jwks.json` (plus de secret partagé) |
| `EMAIL_DOMAIN` | `gmail.com` en test (`smartcampus.tn` en vrai) |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | Gmail : `smtp.gmail.com`, `587`, l'adresse, et un **mot de passe d'application Google** (jamais le mot de passe du compte) |
| `FRONTEND_URL` | Adresse du front (les boutons des e-mails). `http://localhost:5173` tant que rien n'est déployé |
| `FIRST_ADMIN_*` | Premier admin créé au démarrage si aucun admin n'existe |

**Front `.env`** :
```
VITE_USE_MOCKS=false                    # true = tout en données fictives
VITE_API_BASE_URL=http://localhost:4001
VITE_EMAIL_DOMAIN=gmail.com             # identique à EMAIL_DOMAIN du backend
# VITE_REAL_API_PREFIXES=/auth,/users,/roles,/login-history   (par défaut)
```
Après toute modification d'un `.env`, **relancer** le serveur concerné.

## 5. Comptes

- Premier admin créé au démarrage : `admin@smartcampus.tn` / `Admin2026!` (valeur par défaut de `.env.example`, **à changer** avant toute démonstration publique). Attention : avec `VITE_EMAIL_DOMAIN=gmail.com`, le formulaire du front refuse cette adresse.
- Compte administrateur de Farah : `yaichfarah1@gmail.com`.
- L'**inscription publique crée toujours un étudiant**. Pour promouvoir un compte sans interface : `npm run set-role -- adresse@gmail.com admin`. Ensuite l'utilisateur doit se **reconnecter**.

## 6. Comment brancher un autre module

1. L'ami lance son microservice (son propre dépôt, sa propre base, un port).
2. Son service vérifie le JWT avec la **clé publique** du user-service (`/.well-known/jwks.json`, RS256 ; voir `docs/NOTE-EQUIPE.md`), relit le rôle, renvoie 403 si interdit, et répond avec le format d'erreur `{ message, code }`.
3. Dans le `.env` du front, il ajoute ses routes à `VITE_REAL_API_PREFIXES` (par exemple `/courses,/enrollments,/timetable,/grades`) et fait pointer `VITE_API_BASE_URL` vers la Gateway.

Les routes attendues de chaque module sont dans `src/features/<module>/README.md` du front. Détail : `docs/NOTE-EQUIPE.md`.

## 7. Décisions et questions en suspens

| Sujet | Statut |
|---|---|
| **D1 : l'admin crée cours, salles, résidences** ; l'enseignant saisit les notes de ses cours et réserve des salles ; l'étudiant s'inscrit | Proposée, **à valider** avec l'encadrant et les responsables des modules. Voir `docs/DECISIONS.md`. Le droit `academic.manage` existe déjà dans la matrice |
| Emploi du temps | Affichage calculé à partir des cours. À confirmer : l'admin saisit-il les séances ? chaque séance a-t-elle une salle ? |
| Liste des enseignants dans « Créer un cours » | À décider : copie via l'événement `UtilisateurCréé`, ou appel de `GET /users?role=teacher` |
| API Gateway | Personne ne l'a encore prise en charge : choix de la technologie et du responsable |
| Ports | Proposition : user 4001, academic 4002, resources 4003, housing 4004, student-life 4005, library 4006 |

## 8. Ce qu'il reste à faire (par priorité)

0. **Commiter le travail du 2 novembre** (rien n'est commité, voir §1 « Ce qui n'est PAS complet ») : `git add -A -- . ":!qc" ":!query"`, puis un commit **sans** ligne `Co-Authored-By`, puis un `push` pour déclencher la CI et lire son résultat.
1. Faire valider la décision D1 puis envoyer `docs/NOTE-EQUIPE.md` aux autres équipes.
2. Choisir et construire l'**API Gateway**.
3. Construire les écrans d'administration manquants (gérer les cours, les salles, les résidences) et les routes correspondantes.
4. **Déployer** le front et le backend, puis mettre l'adresse publique dans `FRONTEND_URL` : c'est ce qui corrigera le lien `localhost` des e-mails.
5. Brancher les autres modules un par un, puis un `docker-compose` global.
6. Côté sécurité : journal d'audit des actions admin, double authentification, secret JWT en RS256 (permettrait aux autres services de vérifier sans partager le secret). *(Déjà fait : refresh token avec rotation et révocation, pagination de `GET /users`.)*
7. Côté fiabilité : MongoDB en réplica set (transactions : supprime la limite de l'outbox), file « dead-letter » et déduplication chez les consommateurs, règles d'alerte sur `outbox_pending_events`, sauvegardes MongoDB. *(Déjà fait : outbox, tests unitaires.)*
8. Côté front : déconnecter automatiquement sur une réponse 401 (jeton expiré ou compte désactivé), puis utiliser `refreshToken` pour renouveler la session et appeler `/v1`.

## 9. Pièges connus

- **Un seul module est réel.** Les autres affichent des données fictives, c'est voulu pour l'instant. Ne pas dire « tout est connecté ».
- **Port occupé** (`Failed running 'src/server.ts'`) : un autre `npm run dev` tourne déjà. L'arrêter avec `Ctrl+C` ou fermer l'autre terminal.
- **Vite change de port** (5174) quand le 5173 est pris : le backend accepte tout `localhost` en développement, mais mieux vaut ne garder qu'un front.
- **Rôle qui ne change pas** après `set-role` : se déconnecter puis se reconnecter.
- **Mot de passe d'application Gmail** : le coller dans le `.env`, sans guillemets, et enregistrer le fichier. Ne jamais le mettre dans git ni dans une discussion.
- **Index MongoDB** : les index uniques sont construits au démarrage avant toute insertion. Si MongoDB a déjà des doublons, la construction échoue sans bruit : nettoyer les doublons puis redémarrer.
- **Lien dans les e-mails vers `localhost`** : normal tant que le front n'est pas déployé.
- **`/metrics` répond 404 en production** si `METRICS_TOKEN` n'est pas défini (voulu : jamais exposé sans jeton). Avec le jeton : `Authorization: Bearer <jeton>`.
- **`/ready` = `DEGRADED`** : RabbitMQ est configuré mais injoignable. Ne **pas** redémarrer le service : les événements attendent en base (collection `outboxes`) et partent seuls au retour du courtier.
- **Sans `RABBITMQ_URL`**, les événements sont seulement journalisés (la boîte d'envoi n'est pas alimentée). C'est le comportement de développement.
- **`SESSION_REVOKED` (401)** : après un `logout-all` ou une réinitialisation de mot de passe, les anciens jetons sont refusés ; se reconnecter.
- **Production = démarrage refusé** si : pas de clé RSA, mot de passe admin par défaut/faible (< 12 car.), `EXPOSE_TEMP_PASSWORD`, cookies non `Secure`. `/docs` y est désactivé (`ENABLE_DOCS=true` pour le forcer). `TRUST_PROXY` vaut 0 par défaut : mettre 1 derrière la Gateway.
- **Plus de compteur d'essais à l'écran** : la connexion répond le même 401 pour tous les échecs (anti-énumération). Compte verrouillé = 15 min puis déverrouillage automatique.
- **Ne jamais tester des échecs de connexion sur un vrai compte** (le compteur d'échecs s'incrémente et peut suspendre le compte) : utiliser une base jetable. Incident déjà arrivé, voir `docs/DEPANNAGE.md` n°12.
- **RabbitMQ sous Docker Desktop (Windows)** : `rabbitmq:3-management` peut planter avec `.erlang.cookie: eacces`. Contournement validé : `rabbitmq:4-management` lancé avec `--user rabbitmq`.
- **Tests : `NODE_ENV=test` doit être posé avant tout import** : c'est le rôle de `test/setup.ts` (chargé par `--import`). Ne pas le retirer du script `test`.
- **Imports TypeScript** : écrire l'extension `.js` dans les imports relatifs (`from "./x.js"`), même dans un fichier `.ts` (mode `NodeNext`).

## 10. Workflow Git de l'équipe

Chaque dépôt n'a qu'**une seule branche** (`FarahFront` pour le front, `FarahBack` pour le backend). On travaille et on pousse dessus directement :
```bash
git switch FarahBack && git pull          # (ou FarahFront dans le dépôt du front)
# ... modifier, puis, avant de pousser :
npm run check                              # backend : lint + typecheck + tests
npm run typecheck && npm run lint && npm test && npm run build   # front
git add -A && git commit -m "module: ce qui a changé"
git push
```
Comme il n'y a plus de relecture par pull request, **les vérifications ci-dessus sont obligatoires avant chaque `push`**, et la CI du backend doit rester verte (onglet *Actions*). Si l'équipe grandit, recréer une branche par fonctionnalité et une pull request relue par un autre membre.
Règles : ne jamais pousser avec `--force`, ne jamais commiter un `.env`, une clé (`keys/`, `*.pem`) ni un mot de passe.

**Récupérer la version à jour :**
- Nouvelle personne : `git clone <adresse>` puis `npm install` et créer son `.env`.
- Déjà cloné : `git pull && npm install`.

Les commits portent uniquement le nom de leur auteur : pas de ligne `Co-Authored-By`.

## 11. Où lire quoi

| Besoin | Fichier |
|---|---|
| **Sécurité : quoi, pourquoi, avec quel outil** | `docs/SECURITE.md` |
| **La CI : comment elle est faite, pourquoi, comment la lire et la réparer** | `docs/CI.md` |
| **DevSecOps : chaque outil, pourquoi, comment, ce qui manque** | `docs/DEVSECOPS.md` |
| **SAST (CodeQL, ESLint) et analyse de l'image Docker (Trivy)** | `docs/SAST-ET-IMAGE-DOCKER.md` |
| **Problèmes rencontrés et comment ils ont été résolus** | `docs/PROBLEMES-ET-SOLUTIONS.md` |
| Comprendre le code de A à Z | `docs/GUIDE-INGENIEUR.md` |
| Besoins, règles métier, critères d'acceptation | `docs/PRD.md` |
| Architecture (système et code) | `docs/ARCHITECTURE.md` |
| **Travailler en local** (installation, journée type, remises à zéro) | `docs/TRAVAIL-EN-LOCAL.md` |
| **À quoi sert chaque fichier** | `docs/REFERENCE-FICHIERS.md` |
| **Refaire le service seul, pas à pas** ; ajouter une route, un module, un événement | `docs/GUIDE-CONSTRUCTION.md` |
| **RabbitMQ, outbox, relais** en profondeur | `docs/RABBITMQ-ET-EVENEMENTS.md` |
| **Comment c'est testé** ; utiliser les tests | `docs/TESTS-ET-VERIFICATION.md` |
| **Dépanner** : méthode, incidents réels, pannes d'exploitation | `docs/DEPANNAGE.md` |
| Contrat d'API interactif | `http://localhost:4001/docs` |
| Liaison front ↔ back et correctifs faits | `docs/INTEGRATION-FRONT-BACK.md` |
| Qui crée les cours et les salles | `docs/DECISIONS.md` |
| Note à envoyer aux autres équipes | `docs/NOTE-EQUIPE.md` |
| Préparer la soutenance | `docs/QUESTIONS-JURY.md` |
| Contrat d'API du module Utilisateurs | `src/features/users/README.md` (dépôt du front) |
