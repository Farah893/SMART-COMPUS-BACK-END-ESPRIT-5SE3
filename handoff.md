# Passation : SmartCampus, module Utilisateurs

Dernière mise à jour : 15 octobre 2026. Ce document permet à une personne qui reprend le projet de savoir **où l'on en est, comment lancer, et quoi faire ensuite**. Les détails techniques sont dans `docs/`.

---

## 1. Où en est le projet

| Élément | État |
|---|---|
| **user-service** (backend Node.js + MongoDB) | Terminé et testé pour le développement |
| **Front React** | Branché au user-service ; fusionné dans `main` (PR n°1) |
| Les 5 autres modules (académique, ressources, résidences, vie étudiante, bibliothèque) | **Front seulement, avec données fictives**. Leurs microservices n'existent pas encore |
| API Gateway | **Non faite** : en développement, le front appelle directement le user-service |
| Déploiement | Non fait : tout tourne en local |

**Vérifié :** 5 tests d'intégration passent ; le service tourne sur une vraie MongoDB ; les e-mails (compte, code, réinitialisation) partent par Gmail ; `typecheck` et `build` du front passent.
**Non vérifié :** parcours complet cliqué dans le navigateur par une autre personne, RabbitMQ, la Gateway, tout déploiement.

## 2. Dépôts et branches

| Dépôt | Adresse | Branches |
|---|---|---|
| Front | `https://github.com/Farah893/SMART-COMPUS-ESPRIT-5SE3-FRONT-END` | `main` (protégée, à jour) · `feature/users-backend-integration` (déjà fusionnée, supprimable) |
| Backend (user-service) | `https://github.com/Farah893/SMART-COMPUS-BACK-END-ESPRIT-5SE3` | `main` et `FarahBack` (même contenu) |

Dossiers sur le PC de Farah : `C:\dev\SMART-COMPUS-ESPRIT-5SE3-FRONT-END` et `C:\dev\SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE`.

## 3. Lancer le projet

**Prérequis :** Node.js 20+ et **MongoDB** installé comme service Windows (port 27017). Docker n'est plus nécessaire.

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
Tests du backend : `npm test`. Un seul `npm run dev` par projet à la fois (sinon le port est occupé).

## 4. Configuration (les `.env` ne sont JAMAIS dans git)

**Backend `.env`** : à compléter à partir de `.env.example`.
| Variable | À mettre |
|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017/smartcampus_users` |
| `JWT_SECRET` | Une longue valeur secrète, **identique pour tous les services** |
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
2. Son service vérifie le JWT avec le **même `JWT_SECRET`**, relit le rôle, renvoie 403 si interdit, et répond avec le format d'erreur `{ message, code }`.
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

1. Faire valider la décision D1 puis envoyer `docs/NOTE-EQUIPE.md` aux autres équipes.
2. Choisir et construire l'**API Gateway**.
3. Construire les écrans d'administration manquants (gérer les cours, les salles, les résidences) et les routes correspondantes.
4. **Déployer** le front et le backend, puis mettre l'adresse publique dans `FRONTEND_URL` : c'est ce qui corrigera le lien `localhost` des e-mails.
5. Brancher les autres modules un par un, puis un `docker-compose` global.
6. Côté sécurité : refresh token avec révocation, journal d'audit des actions admin, double authentification, secret JWT en RS256, pagination de `GET /users` (limite actuelle de 500).
7. Côté fiabilité : pattern *outbox* pour les événements (sans lui, un événement est perdu si RabbitMQ est absent), tests unitaires, sauvegardes MongoDB.
8. Côté front : déconnecter automatiquement sur une réponse 401 (jeton expiré ou compte désactivé).

## 9. Pièges connus

- **Un seul module est réel.** Les autres affichent des données fictives, c'est voulu pour l'instant. Ne pas dire « tout est connecté ».
- **Port occupé** (`Failed running 'src/server.js'`) : un autre `npm run dev` tourne déjà. L'arrêter avec `Ctrl+C` ou fermer l'autre terminal.
- **Vite change de port** (5174) quand le 5173 est pris : le backend accepte tout `localhost` en développement, mais mieux vaut ne garder qu'un front.
- **Rôle qui ne change pas** après `set-role` : se déconnecter puis se reconnecter.
- **Mot de passe d'application Gmail** : le coller dans le `.env`, sans guillemets, et enregistrer le fichier. Ne jamais le mettre dans git ni dans une discussion.
- **Index MongoDB** : les index uniques sont construits au démarrage avant toute insertion. Si MongoDB a déjà des doublons, la construction échoue sans bruit : nettoyer les doublons puis redémarrer.
- **Lien dans les e-mails vers `localhost`** : normal tant que le front n'est pas déployé.

## 10. Workflow Git de l'équipe

Personne ne pousse sur `main`. Chacun travaille sur sa branche :
```bash
git switch main && git pull
git switch -c feature/<module>-<sujet>
# ... modifier, puis :
npm run typecheck && npm run build        # front
git add . && git commit -m "module: ce qui a changé"
git push -u origin feature/<module>-<sujet>
```
Puis une **Pull Request** vers `main`, relue par un autre membre, puis *Merge*.

**Récupérer la version à jour :**
- Nouvelle personne : `git clone <adresse>` puis `npm install` et créer son `.env`.
- Déjà cloné, sans travail en cours : `git switch main && git pull && npm install`.
- Déjà cloné avec une branche en cours : `git switch main && git pull`, puis `git switch <sa-branche> && git merge main` (résoudre les conflits s'il y en a).

Les commits portent uniquement le nom de leur auteur : pas de ligne `Co-Authored-By`.

## 11. Où lire quoi

| Besoin | Fichier |
|---|---|
| Comprendre le code de A à Z | `docs/GUIDE-INGENIEUR.md` |
| Besoins, règles métier, critères d'acceptation | `docs/PRD.md` |
| Architecture et rôle de chaque fichier | `docs/ARCHITECTURE.md` |
| Liaison front ↔ back et correctifs faits | `docs/INTEGRATION-FRONT-BACK.md` |
| Qui crée les cours et les salles | `docs/DECISIONS.md` |
| Note à envoyer aux autres équipes | `docs/NOTE-EQUIPE.md` |
| Préparer la soutenance | `docs/QUESTIONS-JURY.md` |
| Contrat d'API du module Utilisateurs | `src/features/users/README.md` (dépôt du front) |
