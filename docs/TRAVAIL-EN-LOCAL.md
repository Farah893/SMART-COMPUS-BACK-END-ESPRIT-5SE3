# Travailler en local : installation, journée type, remises à zéro

Ce document décrit **comment on travaille concrètement sur sa machine** : première installation, boucle de travail quotidienne, vérifications avant de commiter, et comment repartir de zéro. Pour comprendre le code : `docs/REFERENCE-FICHIERS.md`. Pour un problème : `docs/DEPANNAGE.md`.

---

## 1. Ce qui tourne sur ta machine

```
 Navigateur ──► Front (Vite)  :5173 ──► user-service :4001 ──► MongoDB :27017
                                              │
                                              ├──► SMTP : Gmail (réel) OU Mailpit :1025 (boîte de test, interface :8025)
                                              └──► RabbitMQ :5672 (facultatif ; interface :15672)
```

| Brique | Obligatoire pour développer? | Comment l'avoir |
|---|---|---|
| Node.js 20.6+ | Oui | `node --version` |
| MongoDB | **Oui** | Service Windows déjà installé (port 27017), **ou** `docker compose up -d mongo` |
| SMTP | Non : un envoi qui échoue est seulement journalisé | Gmail (mot de passe d'application) **ou** Mailpit : `docker compose up -d mailpit` |
| RabbitMQ | Non : sans `RABBITMQ_URL`, les événements sont seulement journalisés | `docker compose up -d rabbitmq` puis `RABBITMQ_URL=amqp://localhost:5672` dans `.env` |
| Docker Desktop | Non pour coder ; oui pour Mailpit/RabbitMQ en conteneur et les vérifications réelles | À démarrer avant toute commande `docker` |

---

## 2. Première installation (une seule fois)

```bash
git clone <adresse-du-depot>
cd SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE
npm install                 # installe les dépendances (lit package-lock.json)
cp .env.example .env        # sous PowerShell : Copy-Item .env.example .env
```
Éditer `.env` (les variables sont documentées dans `.env.example`). Le **minimum** pour démarrer :

| Variable | Valeur en développement |
|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017/smartcampus_users` (déjà le défaut) |
| `JWT_SECRET` | n'importe quelle chaîne en dev (HS256). En production : clé RSA (`npm run keys:generate`, `JWT_PRIVATE_KEY_FILE`) ; les autres services vérifient via `/.well-known/jwks.json` |
| `EMAIL_DOMAIN` | `gmail.com` pour tester avec de vraies adresses, `smartcampus.tn` sinon (doit être identique à `VITE_EMAIL_DOMAIN` du front) |
| `FIRST_ADMIN_EMAIL` / `FIRST_ADMIN_PASSWORD` | l'administrateur créé au premier démarrage |

**Contrôle**
```bash
npm run check
```
Doit afficher `pass 47`, `fail 0`. Le **premier** lancement des tests télécharge un binaire MongoDB (quelques dizaines de Mo) : connexion internet requise, une seule fois.

> Sans fichier `.env`, `npm run dev` s'arrête immédiatement (le script utilise `--env-file=.env`). Après toute modification du `.env`, **relancer** le serveur.

---

## 3. La journée type (boucle de travail)

### 3.1 Démarrer
```bash
# 1. Si besoin, les dépendances en conteneur (Docker Desktop démarré) :
docker compose up -d mailpit rabbitmq     # facultatif

# 2. Le service, avec rechargement automatique à chaque modification :
npm run dev                               # http://localhost:4001
```
Au démarrage tu dois voir, dans l'ordre : `MongoDB connecté`, éventuellement `administrateur fixe créé`, puis `http://localhost:4001 (santé : /health · prêt : /ready · docs : /docs)`.

Le front, dans **un autre terminal** (autre dépôt) : `npm run dev` ⇒ `http://localhost:5173`.

> **Un seul `npm run dev` par projet.** Sinon : `Le port 4001 est déjà utilisé` ⇒ fermer l'autre terminal (`Ctrl+C`).

### 3.2 Vérifier que ça tourne
| Quoi | Où | Attendu |
|---|---|---|
| Vivant | http://localhost:4001/health | `{"service":"user-service","status":"UP"}` |
| Prêt | http://localhost:4001/ready | `UP` (`DEGRADED` si `RABBITMQ_URL` est défini mais RabbitMQ éteint) |
| API interactive | http://localhost:4001/docs | Swagger : on peut appeler les routes depuis le navigateur |
| E-mails de test | http://localhost:8025 (Mailpit) | les e-mails envoyés par le service |
| Métriques | http://localhost:4001/metrics | texte Prometheus (libre en dev ; jeton exigé en production) |

### 3.3 Coder, avec la boucle courte
1. Modifier un fichier de `src/` : `npm run dev` redémarre tout seul.
2. Écrire/adapter le test correspondant (voir `docs/TESTS-ET-VERIFICATION.md`, « Mode d'emploi »).
3. Lancer **uniquement** le test concerné pendant que tu travailles :
   ```bash
   node --import tsx --import ./test/setup.ts --test --watch test/user.service.test.ts
   ```
4. Essayer à la main avec Swagger (`/docs`) ou le front.

### 3.4 Lire ce que fait le service
- Les logs sont dans le terminal du `npm run dev`, **lisibles** en développement (`pino-pretty`). Plus de détails : `LOG_LEVEL=debug` dans `.env`.
- Chaque réponse porte l'en-tête `x-request-id` ; la même valeur est dans **tous** les logs de cette requête (champ `reqId`) : c'est le fil pour suivre une requête.
- Une erreur 500 affiche seulement « Erreur interne du serveur » au client ; **le détail est dans le terminal**.

### 3.5 Avant chaque commit
```bash
npm run check          # lint + types + 47 tests  (obligatoire)
```
Avant de **pousser** (ou de toucher à l'outbox, aux sessions, au Dockerfile) :
```bash
npm run test:coverage  # seuils de couverture
npm run audit:prod     # 0 vulnérabilité haute
npm run build          # la version compilée se construit
```
La CI refait exactement cela ; autant la devancer.

### 3.6 Commiter et pousser (rappel)
Une seule branche par dépôt (`FarahBack` pour le backend, `FarahFront` pour le front) ; vérifier avant chaque `push` :
```bash
git add <fichiers>                     # de préférence fichier par fichier ; jamais .env
git status --short                     # relire ce qui part
git commit -m "module: ce qui a changé"
git push                              # pas de force-push ; la CI doit rester verte
```
Détail complet (récupérer la version à jour, conflits) : `handoff.md` §10. Les commits portent **uniquement le nom de leur auteur** (pas de ligne `Co-Authored-By`).

---

## 4. Outils du quotidien

| Besoin | Commande |
|---|---|
| Promouvoir un compte admin sans interface | `npm run set-role -- adresse@gmail.com admin` (puis se **reconnecter**) |
| Recréer permissions + admin fixe | `npm run seed` (idempotent) |
| Voir le contenu de la base | `mongosh smartcampus_users` puis `db.users.find().limit(5)` ; collections : `users`, `loginevents`, `permissions`, `tokens`, `counters`, `refreshtokens`, `outboxes` |
| Voir les événements en attente | `db.outboxes.find({status:"pending"})` |
| Tester les e-mails sans Gmail | Mailpit : `SMTP_HOST=localhost`, `SMTP_PORT=1025`, interface http://localhost:8025 |
| Tester RabbitMQ en local | `docker compose up -d rabbitmq`, `RABBITMQ_URL=amqp://localhost:5672`, interface http://localhost:15672 (`guest`/`guest`) |
| Construire et lancer la version compilée | `npm run build && npm start` |
| Construire l'image Docker | `docker build -t smartcampus-user-service .` |
| Tout lancer en conteneurs | `docker compose --profile full up -d` (exige `JWT_PRIVATE_KEY`, `FIRST_ADMIN_EMAIL` et `FIRST_ADMIN_PASSWORD` dans l'environnement) |

---

## 5. Repartir de zéro

| Je veux… | Comment |
|---|---|
| **Vider la base de développement** | `mongosh smartcampus_users --eval "db.dropDatabase()"` puis relancer `npm run dev` (le seed recrée permissions et admin). ⚠️ Détruit **tous** les comptes de la base visée : vérifier le nom de la base. |
| **Une base jetable pour tester sans risque** | `MONGODB_URI=mongodb://localhost:27017/test_jetable` (variable posée seulement pour cette commande) ; la supprimer ensuite. **Toujours utiliser une base jetable pour tester des échecs de connexion** (le compteur d'échecs d'un vrai compte s'incrémente et peut le suspendre). |
| **Débloquer un compte suspendu** | Connecté en admin : `PATCH /users/:id/status {"status":"active"}` (Swagger `/docs`) |
| **Réinstaller proprement les dépendances** | supprimer `node_modules`, puis `npm ci` (respecte `package-lock.json`) |
| **Repartir d'un état git propre** | `git stash` (met le travail de côté) ou `git restore <fichier>`. ⚠️ `git restore` et `git checkout --` suppriment les modifications non commitées. |

---

## 6. Problèmes fréquents en local

| Symptôme | Cause | Solution |
|---|---|---|
| `Le port 4001 est déjà utilisé` | Un autre `npm run dev` tourne | Fermer l'autre terminal, ou changer `PORT` |
| `démarrage impossible : MongoDB injoignable` | MongoDB arrêté | Démarrer le service MongoDB (ou `docker compose up -d mongo`) |
| `Configuration invalide : - X : …` | Variable mal formée dans `.env` | Corriger la ligne indiquée |
| Le rôle ne change pas après `set-role` | Le jeton garde l'ancien rôle côté front | Se déconnecter puis se reconnecter |
| Le front est refusé par CORS | Origine non autorisée | En dev tout `localhost:*` est accepté ; sinon vérifier `CORS_ORIGINS` |
| Le formulaire du front refuse `admin@smartcampus.tn` | `VITE_EMAIL_DOMAIN=gmail.com` | Utiliser une adresse du domaine configuré ou aligner les deux variables |
| Aucun e-mail reçu | SMTP non configuré (l'échec est seulement journalisé) | Voir le terminal (« e-mail non envoyé ») ; utiliser Mailpit ou configurer Gmail |
| Premier `npm test` très long | Téléchargement du binaire MongoDB | Normal une seule fois |
| `docker : failed to connect to the docker API` | Docker Desktop n'est pas démarré | Le lancer, attendre qu'il soit prêt |
| `RabbitMQ … eacces` sous Docker Desktop | Droits du cookie Erlang (Windows) | `docker run … --user rabbitmq … rabbitmq:4-management` (voir `docs/DEPANNAGE.md` n°13) |

Plus de pannes et la méthode de diagnostic : `docs/DEPANNAGE.md`.
