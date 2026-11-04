# La CI (intégration continue) : comprendre, lire, réparer

Public visé : un ingénieur qui veut comprendre **ce que fait la CI, pourquoi elle existe et comment la lire**.
Fichier réel décrit ici : `.github/workflows/ci.yml`. Dernière mise à jour : 4 novembre 2026.

---

## 1. En une phrase

La **CI** (Continuous Integration) est un robot qui, **à chaque `git push`**, reprend ton code sur une **machine neuve** et refait toutes les vérifications. Si une seule échoue, GitHub te prévient (c'est l'e-mail « CI failed »).

```
 ton PC                       GitHub                          machine Ubuntu neuve (temporaire)
┌────────┐   git push    ┌───────────┐   lit ci.yml     ┌────────────────────────────────────┐
│ ton    │ ────────────► │ dépôt     │ ───────────────► │ 1. récupère le code                │
│ code   │               │ FarahBack │                  │ 2. installe Node + dépendances     │
└────────┘               └───────────┘                  │ 3. lint, types, build, audit, tests│
                              ▲                          │ 4. construit l'image Docker        │
                              │  ✅ / ❌ + e-mail        │ 5. la lance et l'interroge (fumée) │
                              └──────────────────────────┴────────────────────────────────────┘
```

## 2. Pourquoi c'est nécessaire

| Sans CI | Avec CI |
|---|---|
| « Ça marche sur mon PC » : un fichier oublié dans git, une dépendance installée à la main, une autre version de Node | La machine est **neuve** à chaque fois : si ça passe, ça passe pour tout le monde |
| On oublie de lancer les tests ou le lint | Lancés **automatiquement**, impossible de les oublier |
| Une faille connue dans une dépendance arrive en production sans que personne le voie | `npm audit` fait échouer le run |
| L'image Docker de production ne démarre pas, on le découvre en ligne | L'image est **construite et démarrée** à chaque push |
| Sans pull request relue, personne ne regarde le code | La CI est la **relecture automatique** (importante depuis qu'il n'y a plus qu'une branche par dépôt) |

La CI ne remplace pas un humain pour juger la conception, mais elle élimine toute une catégorie d'erreurs évitables.

## 3. Où elle tourne (et ce qui se passe où)

- **Sur les serveurs de GitHub Actions** : des machines Ubuntu temporaires, détruites après chaque run. Pas sur ton PC, pas chez Claude.
- **Rien à installer** : GitHub lit `.github/workflows/ci.yml` tout seul dès que le fichier est dans le dépôt.
- **Résultats** : onglet **Actions** du dépôt (`github.com/Farah893/SMART-COMPUS-BACK-END-ESPRIT-5SE3/actions`), et e-mail en cas d'échec.
- **Sur ton PC**, tu peux *rejouer* les mêmes commandes avant de pousser (§8). Ce n'est pas la vraie CI : c'est une répétition, utile mais qui ne remplace pas la machine neuve.

## 3b. Comment on construit une CI, de zéro (la méthode)

Une CI n'invente rien : elle **automatise les commandes que tu tapais déjà à la main**. Méthode :

1. **Liste ce que tu lances avant de pousser** : `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`… Si une commande n'existe pas encore en local, crée-la d'abord dans `package.json` (`"scripts"`). Une commande qui ne marche pas chez toi ne marchera pas en CI.
2. **Fais-les passer sur une machine neuve** : `npm ci` (et non `npm install`) reproduit une installation propre. Si ça marche, la machine de GitHub réussira aussi.
3. **Écris le fichier** `.github/workflows/ci.yml` : *quand* (`on:`), *où* (`runs-on: ubuntu-latest`), *quoi* (`steps:` : récupérer le code, installer Node, puis une ligne `run:` par commande, dans l'ordre : du plus rapide au plus lent, pour échouer vite).
4. **Pousse et regarde l'onglet Actions** : le premier run échoue presque toujours (version de Node, variable d'environnement manquante, chemin Windows). C'est normal : lis l'étape rouge, corrige, repousse.
5. **Ajoute les contrôles qui protègent vraiment** une fois la base verte : audit des dépendances, seuils de couverture, test de fumée du conteneur. Chaque nouveau contrôle doit avoir déjà échoué volontairement au moins une fois chez toi, sinon on ne sait pas s'il détecte quelque chose.

**Règles de qualité d'une bonne CI** : rapide (quelques minutes), déterministe (mêmes résultats à chaque fois), bloquante sur ce qui compte (sécurité, build), et lisible (une étape = un nom clair).

## 4. Le fichier, pas à pas

### 4.1 Déclenchement et garde-fous
```yaml
on:
  push:
  pull_request:
```
Lancée à chaque push (toute branche) et à chaque pull request.

```yaml
permissions:
  contents: read
```
Le robot n'a que le **droit de lire** le code. Si quelqu'un parvenait à y glisser une commande malveillante, il ne pourrait rien modifier dans ton dépôt (moindre privilège).

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```
Si tu pousses deux fois de suite sur la même branche, l'ancien run est **annulé** : inutile de vérifier une version déjà dépassée.

### 4.2 Travail `check` : « le code est-il bon ? »

```yaml
check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npm run lint
    - run: npm run typecheck
    - run: npm run build
    - run: npm run audit:prod
    - run: npm run test:coverage
```

| # | Étape | Ce que ça fait | Ce que ça attrape | Si ça échoue |
|---|---|---|---|---|
| 1 | `actions/checkout` | Télécharge ton code sur la machine neuve | — | rare |
| 2 | `setup-node` (Node 22) | Installe une version de Node connue, avec cache des dépendances | « Chez moi c'est Node 24 » | rare |
| 3 | `npm ci` | Installe les dépendances **exactement** comme dans `package-lock.json` (≠ `npm install`, qui peut les faire varier) | Lockfile désynchronisé du `package.json` | lance `npm install` en local, commite `package-lock.json` |
| 4 | `npm run lint` | ESLint : règles de qualité | Variable inutilisée, promesse oubliée, `console.log` | corrige la ligne indiquée |
| 5 | `npm run typecheck` | `tsc --noEmit` : cohérence des types TypeScript | Mauvais type, propriété qui n'existe pas | corrige le type |
| 6 | `npm run build` | Compile vraiment le TypeScript vers `dist/` | Ce qui est livré ne se construit pas | corrige l'erreur de compilation |
| 7 | `npm run audit:prod` | `npm audit --omit=dev --audit-level=high` | Dépendance de production avec une **faille haute ou critique** | mets la dépendance à jour |
| 8 | `npm run test:coverage` | Lance les tests (MongoDB en mémoire) **et** impose des seuils : lignes 90 %, branches 80 %, fonctions 80 % | Régression, et baisse silencieuse de la couverture | corrige le test ou le code ; ne baisse pas le seuil pour « faire passer » |

### 4.3 Travail `docker` : « le service livré démarre-t-il en production ? »

```yaml
docker:
  needs: check          # attend que `check` soit vert
  services:
    mongo: { image: mongo:7, ... }   # une vraie base MongoDB à côté
```

1. **`docker build -t smartcampus-user-service .`** : construit l'image avec le `Dockerfile` (3 étapes : compilation → dépendances de production → image finale sans droits root).
2. **Smoke test** (« test de fumée » : on allume l'appareil, on regarde s'il fume) : lance le conteneur **en mode production** avec une vraie clé RSA générée à la volée, puis l'interroge :

| Contrôle | Commande (extrait) | Ce que ça prouve |
|---|---|---|
| Santé | `curl -fsS /health` | Le processus tourne |
| Prêt | `curl -fsS /ready` | MongoDB est joignable |
| Clés publiques | `jwks.json` contient `"kty":"RSA"` | RS256 est actif |
| Pas de clé privée | `jwks.json` ne contient **pas** `"d":` | La clé privée n'est jamais publiée |
| Documentation fermée | `/docs/` répond **404** | Pas de plan de l'API en production |
| Métriques protégées | avec jeton → 200 ; sans jeton → **401** | `/metrics` n'est pas public |
| Connexion admin | `POST /v1/auth/login` renvoie `refreshToken` | Démarrage, amorçage de l'admin, bcrypt, JWT, base : toute la chaîne |

3. **Logs du conteneur** (seulement en cas d'échec) : `docker logs svc`, pour voir *pourquoi* il n'a pas démarré.

**Pourquoi deux travaux ?** `check` prouve que la **logique** est juste ; `docker` prouve que la **chose livrée** fonctionne. Les tests unitaires ne lancent pas l'image de production, donc ils ne voient pas certaines pannes (voir l'incident §6).

## 5. Un point technique qui piège : `bash -eo pipefail`

**Correction d'une erreur de la première version de ce document** : GitHub n'active **pas** `pipefail` par défaut. Sans précision, un bloc `run: |` s'exécute avec `bash -e` : le script s'arrête à la première commande qui échoue, **mais** dans un tube `a | b` seule la dernière commande compte. Un `curl ... | grep -q ...` dont le `curl` échoue peut donc passer pour réussi. Avec `shell: bash` explicite, GitHub utilise `-eo pipefail`.
Dans ce dépôt, le test de fumée commence par `set -euo pipefail` : il est strict, et je l'ai rejoué en local dans ce mode avant de pousser.
```bash
bash -eo pipefail script.sh    # reproduire le mode strict en local
```

## 6. Étude de cas : l'incident du 4 novembre (CI rouge, e-mail reçu)

**Symptôme.** Après mon push `29e9948`, e-mail « CI failed ». Le travail `check` était vert, le travail `docker` rouge à l'étape *Smoke test*.

**Enquête.**
1. GitHub expose les résultats par son interface publique (dépôt public) → l'étape en échec était *Smoke test*.
2. Les journaux GitHub exigent d'être connecté, donc j'ai **reproduit en local** : build de production, mêmes variables d'environnement, mêmes commandes, même mode `-eo pipefail`.
3. Le serveur ne démarrait pas du tout :
   ```
   Error: Configuration de production refusée :
     - COOKIE_SECURE ne doit pas être désactivé en production
   ```

**Cause.** Une contradiction **de ma part** : j'avais ajouté une règle (« en production, les cookies doivent être `Secure` ») *et* écrit `-e COOKIE_SECURE=false` dans le test de fumée et dans `docker-compose.yml`. Le conteneur obéissait à la règle… et refusait de démarrer.

**Correction.** Retrait du `COOKIE_SECURE=false` dans `ci.yml` et `docker-compose.yml` ; test de fumée relancé en local (7/7) ; push `d8ab8c7` ; CI **verte** (`check` ✅, `docker` ✅).

**Leçons.**
- La CI a fait exactement son travail : elle a attrapé une panne de production que **77 tests unitaires ne pouvaient pas voir**.
- Première chose à faire sur un échec : lire l'étape en rouge, puis reproduire en local la même commande.
- D'autres e-mails venaient des branches **Dependabot** (robot de mise à jour des dépendances) : chacune déclenchait la CI et échouait, car certaines montées de version cassent le code. Dependabot est désormais désactivé (`.github/dependabot.yml`).

## 7. Comment lire un échec (procédure)

1. GitHub → onglet **Actions** → clique sur le run rouge (il porte le message de ton commit).
2. Clique sur le **travail** rouge (`check` ou `docker`), à gauche.
3. Ouvre l'**étape** marquée ❌ : la vraie erreur est tout en bas de son journal.
4. Reproduis en local la **même commande** (§8). Corrige. Pousse.
5. Si tu ne comprends pas l'erreur : copie les ~20 dernières lignes de l'étape.

## 8. Rejouer la CI sur ton PC avant de pousser

```bash
npm ci                   # (facultatif) installation propre
npm run lint
npm run typecheck
npm run build
npm run audit:prod
npm run test:coverage    # tests + seuils
```
Raccourci : `npm run check` = lint + typecheck + tests. Le travail `docker` demande Docker Desktop démarré ; sans lui, on peut lancer le build de production directement (`npm run build`, puis `node --import ./dist/instrumentation.js dist/server.js` avec les variables du test de fumée).

## 9. Ce que la CI ne fait pas (limites honnêtes)

- **Pas de test de l'interface** dans un navigateur.
- **Pas d'analyse de ton propre code** à la recherche de failles (SAST, ex. CodeQL) : seulement les dépendances (`npm audit`).
- **Pas de déploiement** : on ne livre rien (pas de CD).
- **Pas de CI pour le front** : le dépôt front n'a pas de dossier `.github`, donc rien ne vérifie le front à chaque push. Voir le §10.
- **Actions non épinglées** : `actions/checkout@v4` désigne une étiquette modifiable ; l'épingler par empreinte (SHA) est plus sûr contre un compromis de l'action.
- **Rien n'empêche de pousser du code rouge** : sans protection de branche, la CI informe mais ne bloque pas.

## 10. Proposition (non installée) : une CI pour le front

À mettre dans `.github/workflows/ci.yml` du dépôt front. Elle reprend les contrôles que l'on lance déjà à la main :
```yaml
name: CI
on: [push, pull_request]
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm audit --omit=dev --audit-level=high
```
Attention : avec les modifications locales actuelles du front (variable `Skeleton` inutilisée), ce workflow échouerait tant qu'elles ne sont pas corrigées : c'est son rôle.

## 11. Glossaire

- **CI / CD** : intégration continue (vérifier) / livraison continue (déployer).
- **Workflow** : le fichier YAML qui décrit la CI. **Job** (travail) : un groupe d'étapes sur une machine. **Step** (étape) : une commande.
- **Runner** : la machine GitHub qui exécute le job.
- **Smoke test** : test rapide qui vérifie que « ça démarre et ça répond ».
- **Couverture** : part du code exécutée par les tests (lignes, branches, fonctions).
- **Lockfile** (`package-lock.json`) : liste exacte des versions installées, pour des installations identiques.
- **Dependabot** : robot GitHub qui propose des mises à jour de dépendances (désactivé ici).
