# DevSecOps sur SmartCampus : ce que c'est, quels outils, comment et pourquoi

Public visé : un ingénieur qui veut comprendre **la chaîne de sécurité de bout en bout**, pas seulement la suivre.
Chaque outil est décrit de la même façon : **Quoi → Pourquoi → Comment (ici) → Ce que ça a donné → Limites**.
Dernière mise à jour : 4 novembre 2026. Compléments : `docs/SECURITE.md` (la sécurité de l'application), `docs/SAST-ET-IMAGE-DOCKER.md` (analyse statique et image), `docs/CI.md` (la CI), `docs/PROBLEMES-ET-SOLUTIONS.md` (journal des problèmes).

---

## 1. Qu'est-ce que le DevSecOps ?

**Dev + Sec + Ops** : intégrer la sécurité (*Sec*) **dans** le développement (*Dev*) et l'exploitation (*Ops*), au lieu de la vérifier une seule fois à la fin.

| Approche classique | DevSecOps |
|---|---|
| Un audit de sécurité avant la mise en production | Des contrôles **à chaque `git push`**, automatiques |
| La sécurité est l'affaire d'une personne ou d'une équipe | Chaque développeur voit les alertes de son propre code |
| On découvre la faille tard : correction chère | On la découvre **minutes** après l'avoir écrite : correction presque gratuite |
| « Ça a été vérifié il y a six mois » | La vérification **est rejouée** à chaque changement |

Le principe clé s'appelle **shift left** (« décaler vers la gauche ») : plus on détecte tôt dans la chaîne, moins la correction coûte.

```
  ÉCRIRE            COMMITER          POUSSER (CI GitHub)                LIVRER             EXPLOITER
 ┌────────┐       ┌──────────┐      ┌──────────────────────────┐      ┌─────────┐       ┌──────────────┐
 │ éditeur│  ──►  │ npm run  │ ──►  │ lint+SAST · types · tests │ ──►  │ image   │  ──►  │ santé, logs, │
 │ + types│       │ check    │      │ audit · signatures        │      │ Docker  │       │ métriques,   │
 └────────┘       │ (local)  │      │ CodeQL · Trivy · fumée    │      │ durcie  │       │ alertes      │
                  └──────────┘      └──────────────────────────┘      └─────────┘       └──────────────┘
   ◄── on attrape le plus tôt possible (shift left) ──────────────────────────────────────────────►
```

---

## 2. Carte des outils : lequel attrape quoi

| Famille | Outil | Étape | Attrape… | Statut |
|---|---|---|---|---|
| Qualité de code | **TypeScript** (`tsc --noEmit`) | local + CI | erreurs de types, valeurs nulles, propriétés inexistantes | en place |
| Qualité de code | **ESLint** + `typescript-eslint` | local + CI | bugs probables, imports inutiles | en place |
| Qualité de code (front) | **Prettier** (`format:check`) | CI | code mal formaté (diffs parasites) | en place |
| **SAST** léger | **eslint-plugin-security** | local + CI | motifs dangereux (regex, fichiers, `eval`…) | en place |
| **SAST** profond | **CodeQL** | CI (push, PR, hebdo) | failles par suivi des données (injection, contournement…) | en place |
| Tests | **node:test** + MongoDB en mémoire (back), **Vitest** (front) | local + CI | régressions de comportement et de sécurité | en place |
| Tests de politique | tests maison (`test/security.test.ts`) | local + CI | règle de sécurité oubliée (action non épinglée, digest manquant…) | en place |
| Couverture | `--test-coverage-lines=90 …` | CI | tests qui s'érodent en silence | en place |
| **SCA** (dépendances) | **npm audit** | CI | dépendance de production avec faille connue | en place |
| Chaîne d'approvisionnement | **npm audit signatures**, `npm ci`, `--ignore-scripts` | CI + Docker | paquet falsifié, script d'installation malveillant | en place |
| Image | **Trivy** (`image`) | CI | paquets de l'image vulnérables, secrets dans les couches | en place |
| Configuration | **Trivy** (`config`), tests du Dockerfile | CI | mauvaises pratiques Docker | en place |
| Durcissement conteneur | **Docker** multi-étapes, non-root, digest, `read_only`… | build + exécution | élévation de privilèges, dérive d'image | en place |
| Test de fumée | conteneur de production + `curl` | CI | « les tests passent mais l'image ne démarre pas » | en place |
| Attaque réelle (DAST) | batterie maison de **82 attaques** | à la main | failles visibles seulement en exécution | fait à la main, **hors CI** |
| Secrets | `.gitignore`, `.dockerignore`, variables d'environnement, fichiers de clés | dépôt | secret commité ou copié dans l'image | en place ; *secret scanning GitHub à activer* |
| Observabilité | `pino` (logs), Prometheus (`/metrics`), OpenTelemetry, `/health` `/ready` | exploitation | panne ou attaque qu'on ne verrait pas | en place ; *alertes à écrire* |
| Gouvernance | `SECURITY.md`, `CODEOWNERS`, branche unique | dépôt | signalement de faille sans canal, propriété floue | en place ; *protection de branche à activer* |
| Revue indépendante | **agents d'audit** en lecture seule | ponctuel | angles morts de l'auteur | fait deux fois |

---

## 3. Chaque outil en détail

### 3.1 TypeScript et ESLint : la première ligne de défense
- **Quoi** : `tsc --noEmit` vérifie les types sans produire de fichier ; ESLint applique des règles de qualité.
- **Pourquoi** : un grand nombre de failles commencent comme de simples bugs (valeur `undefined` non gérée, mauvais type de champ). Un type strict les interdit avant même l'exécution.
- **Comment** : `npm run lint` (`eslint . --max-warnings 0`) et `npm run typecheck`. Dans la CI, étapes 4 et 5 du travail `check`.
- **Résultat** : 0 erreur, 0 avertissement toléré.
- **Limite** : ne comprend pas la logique métier.

### 3.2 `eslint-plugin-security` : SAST rapide
- **Quoi** : règles ESLint qui signalent des motifs à risque : `new RegExp(variable)`, accès `fs` avec un chemin variable, `obj[clé]` avec clé variable…
- **Pourquoi** : retour **immédiat**, dans l'éditeur et en local. Il ne suit pas les données (il ne sait pas d'où vient la variable), donc beaucoup de faux positifs.
- **Comment** : `security.configs.recommended` dans `eslint.config.js`. J'ai **lu le code derrière chacune des 27 alertes** avant de décider : 26 faux positifs ou cas acceptables (chacun avec sa raison, écrite à côté dans le code), 1 vrai durcissement (`key in obj` → `Object.hasOwn`). La règle `detect-object-injection`, 100 % faux positifs ici, est désactivée **avec la justification dans le fichier**.
- **Garde-fou** : `--max-warnings 0` : **toute nouvelle alerte fait échouer la CI**. Sans cela, un avertissement n'est lu par personne.

### 3.3 CodeQL : SAST profond
- **Quoi** : construit une base de données du programme et exécute des requêtes qui suivent une donnée de sa **source** (requête HTTP) à son **puits** dangereux (base, fichier, réponse).
- **Pourquoi** : il comprend les flux, ce que le plugin ESLint ne peut pas. Il a trouvé ce que mes tests ne cherchaient pas.
- **Comment** : `.github/workflows/codeql.yml` (jeu `security-extended`, à chaque push, pull request et chaque lundi), avec `.github/codeql/codeql-config.yml` qui exclut `test/`. Droit d'écriture `security-events` limité à **ce seul travail**. Installé dans le backend **et** le front.
- **Ce qu'il a trouvé (3 alertes, toutes dans mon code)** :

  | Alerte CodeQL | Cause réelle | Correction |
  |---|---|---|
  | *Use of a weak cryptographic key* | `generateKeyPairSync("rsa", { modulusLength: 1024 })` dans un **test** : clé faible créée exprès pour prouver que le service la refuse | `test/` exclu de l'analyse (les tests ne sont pas livrés) ; la protection réelle (refus des clés < 2048 bits) reste testée |
  | *Potential file system race condition* | `generate-keys.ts` testait `existsSync(fichier)` **puis** écrivait : entre les deux, un autre processus pouvait créer ou remplacer le fichier (TOCTOU) | Création **exclusive** (`flag: "wx"`) avec droits `0600` posés à la création : une seule opération du système, aucune fenêtre |
  | *User-controlled bypass of security checks* | le contrôle CSRF était sauté si l'appelant ajoutait un en-tête `Authorization` valide ou un jeton dans le corps, et l'accès d'un compte à mot de passe temporaire dépendait de l'**URL** demandée | CSRF appliqué **dès que nos cookies sont joints**, quelle que soit la provenance du jeton ; l'accès temporaire est décidé par la **route** (`authenticateAllowTemporary`), pas par l'adresse |

  Pour la 3ᵉ, le test écrit **échoue sur l'ancien code et passe sur le nouveau** : la faille théorique est devenue un comportement vérifié.
- **Limite** : voit le code, pas la logique métier (« un étudiant peut-il lire le profil d'un autre ? » : c'est le rôle des tests d'autorisation).

### 3.4 Tests, couverture et tests de politique
- **Quoi / pourquoi** : les tests prouvent que le comportement est correct **et le restent**. La couverture (`--test-coverage-lines=90 --test-coverage-branches=80 --test-coverage-functions=80`) empêche qu'ils s'érodent. Les **tests de politique** transforment une règle de sécurité en test.
- **Comment** : 85 tests, MongoDB en mémoire (aucune base à installer). Dans `test/security.test.ts` :
  - YAML des workflows valide ;
  - chaque action GitHub **épinglée par SHA**, permissions en **lecture seule**, `timeout-minutes` ;
  - Dockerfile : digest, `--ignore-scripts`, npm retiré **avant** `USER node` ;
  - démarrage en production **refusé** avec une configuration faible (processus fils) ;
  - limiteurs de débit sur un mini-serveur, RS256 (confusion d'algorithme, `alg:none`, rotation) ;
  - garde d'authentification sans lecture de l'URL ; création exclusive de la clé.
- **Règle d'or appliquée** : **un contrôle doit pouvoir échouer.** J'ai prouvé que le test du Dockerfile détecte un défaut en retirant volontairement un digest (il est devenu rouge), puis en le restaurant. J'ai aussi retiré un faux contrôle que j'avais écrit dans la CI du front (il cherchait une chaîne présente dans tous les builds).

### 3.5 SCA et chaîne d'approvisionnement : `npm audit`, `npm ci`, signatures
- **Quoi** : `npm audit` compare `package-lock.json` à une base de failles connues. `npm ci` installe **exactement** le lockfile. `npm audit signatures` vérifie la signature (et l'attestation de provenance) de chaque paquet installé.
- **Pourquoi** : 90 % du code d'une application Node n'est pas le nôtre. Une faille ou un paquet piégé dans une dépendance est une faille chez nous.
- **Comment** : `npm run audit:prod` (échec sur HIGH ou CRITICAL en production), `npm audit signatures`, `npm ci` en CI et en Docker. **`--ignore-scripts`** dans le Dockerfile : aucun script d'installation de dépendance ne s'exécute pendant la construction.
- **Ce que ça a donné** :
  - production : 0 vulnérabilité (backend et front) ;
  - 392 paquets backend et 503 front avec signatures vérifiées ;
  - **découverte** : `@scarf/scarf` (arrivé via `swagger-ui-dist`) lançait à l'installation un script qui **envoie de la télémétrie vers un serveur externe** ; neutralisé par `--ignore-scripts` et `SCARF_ANALYTICS=false`. Le service démarre sans lui (simulation de l'étape Docker : 159 paquets, connexion admin = 200).
  - `zod` du front mis à jour (faille d'épuisement de mémoire).
- **Limite** : `npm audit` ne connaît que les failles **publiées**. Les dépendances de développement (11 alertes modérées, build seulement) ne bloquent pas la CI, par choix.

### 3.6 Trivy : analyse de l'image Docker
- **Quoi** : scanne l'image construite (paquets Alpine, `node_modules`, secrets) et la configuration du Dockerfile.
- **Pourquoi** : `npm audit` ne voit que `package-lock.json`. L'image contient **aussi** le système d'exploitation, Node et npm : tout cela peut être vulnérable.
- **Comment** : deux étapes du travail `docker`, version **épinglée** (`aquasec/trivy:0.57.1`). Options : `--severity HIGH,CRITICAL` (on bloque ce qui compte), `--ignore-unfixed` (on ne punit pas ce qu'on ne peut pas corriger). Un script maison (`.github/scripts/trivy-annotations.mjs`) transforme le rapport JSON en **annotations lisibles** et distingue « erreur d'exécution de Trivy » de « vulnérabilité trouvée ».
- **Ce qu'il a trouvé** : 6 vulnérabilités HIGH, **toutes dans npm lui-même** (`pacote`, `sigstore`, `picomatch`, `brace-expansion`, `ip-address`), livré avec l'image Node. Aucune dans l'application.
- **Ma décision** : **retirer npm, npx, corepack et yarn de l'image finale**, plutôt que d'ignorer l'alerte (`.trivyignore`). Pourquoi : un conteneur de production n'a pas besoin d'un gestionnaire de paquets, et un attaquant qui y obtient un shell ne peut plus installer d'outils. La surface disparaît au lieu d'être masquée.
- **Preuve** : run GitHub suivant : Trivy vert sur l'image, puis sur le Dockerfile.

### 3.7 Docker : l'image comme artefact de sécurité
| Mesure | Menace couverte |
|---|---|
| Build en 3 étapes (compilation / dépendances de production / exécution) | code de test, outils de build et sources absents de l'image finale |
| Image de base épinglée par **digest** (`@sha256:…`) | une étiquette comme `22-alpine` change sans prévenir ; le digest est immuable. Contrepartie : à rafraîchir (Trivy devient rouge quand l'image épinglée a une faille corrigeable : c'est le signal) |
| `USER node` (non root) | une faille dans l'application n'ouvre pas les droits root du conteneur |
| `HEALTHCHECK` | un service bloqué est détecté et redémarré |
| `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, `mem_limit`, `pids_limit`, `init` (compose) | un attaquant qui exécute du code ne peut ni écrire dans l'image, ni élever ses droits, ni épuiser la machine |
| Ports liés à `127.0.0.1` | MongoDB sans authentification n'est jamais joignable du réseau |
| `.dockerignore` (`.env.*`, `keys`, `*.pem`, `coverage`) | un secret copié dans une couche y reste à jamais |

### 3.8 Le test de fumée : « allumer l'appareil »
- **Pourquoi** : tous les tests peuvent être verts alors que **l'image de production ne démarre pas**. C'est arrivé : j'avais ajouté une règle de démarrage (`COOKIE_SECURE` obligatoire) tout en forçant le réglage inverse dans la CI.
- **Comment** : le conteneur est lancé en mode production avec une clé RSA générée à la volée, puis interrogé : santé, `/ready`, clés publiques (JWKS) **sans** partie privée, `/docs` en **404**, `/metrics` protégé, connexion de l'administrateur. Script en `set -euo pipefail` (GitHub n'active **pas** `pipefail` par défaut).

### 3.9 La batterie de 82 attaques (DAST maison)
- **Quoi** : un script qui attaque le service **lancé en production** (base jetable, limiteurs actifs) : en-têtes, CORS, énumération de comptes (corps **et temps** de réponse), verrouillage, force brute, faux `X-Forwarded-For`, jetons forgés (confusion RS256→HS256, `alg:none`), CSRF (dont `Origin: null`), injection NoSQL, ReDoS, corps géants, IDOR, révocation.
- **Pourquoi** : certaines failles n'existent qu'à l'exécution (l'analyse statique ne les voit pas).
- **Résultat** : 82 sur 82. **Limite honnête** : lancé à la main, **pas dans la CI** ; il ne remplace pas un test d'intrusion externe.

### 3.10 Gestion des secrets
- **Principe** : un secret ne va jamais dans git, dans l'image, ni dans un journal.
- **Comment** : `.env` ignoré ; clé RSA dans `keys/` (ignoré, droits `0600`) ou en variable d'environnement ; **l'index git est scanné avant chaque commit** (fichiers `.env`/`.pem`/`.key`, motifs de clés) ; masquage de `Authorization`, `Cookie` et `Set-Cookie` dans les logs ; le service **refuse de démarrer** en production avec un secret faible ou le mot de passe admin par défaut. Un agent a relu **tout l'historique git des deux dépôts** : aucun secret trouvé.
- **À activer par toi** : *secret scanning* et *push protection* de GitHub (bloque un `git push` qui contient une clé).

### 3.11 Observabilité : voir ce qui se passe en production
- `pino` : journaux JSON avec identifiant de requête ; `prom-client` : métriques Prometheus (`/metrics`, protégé par jeton comparé en temps constant) ; **OpenTelemetry** : traces ; `/health` (vivant) et `/ready` (base joignable).
- **Pourquoi en DevSecOps** : une attaque se détecte par des **signaux** (pic d'échecs de connexion, `/ready` qui tombe, file d'événements qui s'accumule). **Limite** : les **règles d'alerte** ne sont pas écrites (voir §6).

### 3.12 Revue indépendante par des agents
- **Quoi** : deux agents distincts, **en lecture seule**, ont relu le projet sans connaître mes conclusions : un audit de sécurité applicatif (24 constats) et un audit DevSecOps (chaîne de livraison, historique git, dépendances, processus).
- **Pourquoi** : l'auteur d'un code a des angles morts. Leur rapport est traité comme une **donnée à vérifier**, pas comme une instruction : j'ai relu le code derrière chaque constat avant d'agir (l'un d'eux m'a fait corriger une erreur de ma documentation sur `pipefail`).

### 3.13 GitHub Actions : la CI elle-même doit être sûre
- Actions **épinglées par SHA de commit** (une étiquette comme `@v4` peut être déplacée par son auteur) ; `permissions: contents: read` par défaut, droits supplémentaires **par travail** ; `persist-credentials: false` ; `timeout-minutes` ; `concurrency` ; aucune donnée non fiable interpolée dans un script (`${{ }}`) ; aucun secret utilisé.
- **Ce qui est vérifié automatiquement** : le test de politique échoue si on ajoute une action non épinglée ou un travail sans durée maximale.
- **Contrepartie** : Dependabot est **désactivé** (il créait une branche et une pull request par dépendance, et des mises à jour majeures cassaient le code). Les SHA, le digest et les dépendances sont donc à rafraîchir à la main (revue mensuelle).

---

## 4. Le déroulé réel : comment ça a été fait, dans l'ordre

1. **Cadrer** : lire le code, la configuration, l'authentification, la CI, le Docker.
2. **Auditer de façon indépendante** (agent n°1) puis **corriger** : 24 constats → tests écrits pour chaque correction.
3. **Prouver en conditions réelles** : service lancé sur base jetable, 82 attaques ; scénario complet du front avec cookies.
4. **Brancher le SAST** : plugin ESLint (tri de 27 alertes), puis CodeQL.
5. **Analyser l'image** : Trivy ; premier échec lisible grâce aux annotations ; cause = npm ; correction par retrait de npm.
6. **Réviser la chaîne de livraison** (agent n°2) : SHA des actions, digest, `--ignore-scripts`, signatures, durcissement du conteneur, `SECURITY.md`, `CODEOWNERS`.
7. **Écouter les alertes de la plateforme** : les 3 alertes CodeQL (clé faible, course de fichiers, contournement par donnée utilisateur) ont été corrigées et testées.
8. **Documenter** (ce dossier `docs/`) et **capitaliser** : skill `security` pour refaire la démarche sur un autre projet.

## 5. Principes qui ont guidé les choix

1. **Détecter tôt** (shift left) : le plus de contrôles possible en local, avant la CI.
2. **Un contrôle doit pouvoir échouer** : sinon il rassure à tort (mutation volontaire du Dockerfile, faux contrôle retiré).
3. **Comprendre avant de masquer** : alerte Trivy → on retire la surface (npm), on n'utilise pas `.trivyignore` ; alerte SAST → on lit le code, on ne désactive pas en bloc.
4. **Moindre privilège partout** : jetons CI en lecture seule, conteneur sans capacités, utilisateur non root, cookies `httpOnly`.
5. **Échouer fermé** : configuration de production faible = démarrage refusé.
6. **Reproduire avant de théoriser** : une CI rouge se rejoue en local avec les mêmes commandes.
7. **Dire ce qui n'est pas fait.**

## 6. Ce qui manque encore (honnêtement)

| Manque | Pourquoi c'est important | Qui / effort |
|---|---|---|
| **Protection de branche** (CI verte exigée, pas de force-push) | aujourd'hui, la CI informe mais **ne bloque rien** | toi (réglage GitHub), 5 min |
| **Secret scanning + push protection** | bloque un secret **avant** qu'il parte | toi (réglage GitHub), 2 min |
| **2FA du compte GitHub**, commits signés | un compte volé annule toute la chaîne | toi |
| **SBOM** (inventaire de l'image) et **signature d'image** (cosign) | prouver ce qu'on livre | moyen |
| **DAST dans la CI** | la batterie de 82 attaques ne tourne qu'à la main | moyen |
| **Pipeline de livraison** (tag, image publiée, environnements, approbation) | aucun déploiement, aucun retour arrière outillé | grand |
| **Alertes** (échecs de connexion en pic, `/ready` en panne, file d'événements) | on ne voit pas une attaque en cours | moyen |
| **Sauvegarde MongoDB testée**, rotation planifiée de la clé RSA | reprise après sinistre, hygiène des secrets | moyen |
| **Entretien manuel** (SHA des actions, digest de l'image, dépendances) | Dependabot étant coupé, tout vieillit | mensuel |
| **CSP côté hébergeur du front** ; test d'intrusion externe | défense du navigateur ; regard extérieur | moyen |
| **Écrans** non testés dans un navigateur | seule la logique du client a été vérifiée | toi / moi si Chrome connecté |

## 7. Ajouter un nouveau contrôle : la méthode
1. **Nommer la menace** en une phrase (« un paquet exécute du code à l'installation »).
2. **Choisir le plus petit outil** qui l'attrape (`--ignore-scripts`).
3. **Le faire échouer exprès** pour prouver qu'il détecte (ajouter un script d'installation, voir le rouge).
4. **Le brancher à la CI** et écrire **pourquoi** à côté (commentaire dans le fichier).
5. **Ajouter un test de politique** si la règle peut être violée par inadvertance plus tard.
6. **Documenter** l'état dans `docs/` : fait, vérifié, limite.

## 8. Glossaire
- **DevSecOps** : sécurité intégrée à tout le cycle, automatisée. **Shift left** : détecter plus tôt.
- **SAST** : analyse du code sans l'exécuter. **DAST** : attaque du service en marche. **SCA** : analyse des dépendances.
- **CI / CD** : intégration continue (vérifier) / livraison continue (déployer).
- **SBOM** : inventaire de tous les composants d'une image. **Digest** : empreinte immuable d'une image.
- **TOCTOU** (*time-of-check to time-of-use*) : le fichier change entre le test et l'utilisation.
- **CSRF** : un site tiers fait agir ton navigateur connecté. **IDOR** : accès à l'objet d'un autre en changeant un identifiant.
- **Moindre privilège** : ne donner que les droits strictement nécessaires.
- **Chaîne d'approvisionnement** (*supply chain*) : tout ce que ton build tire de l'extérieur (paquets, actions, images).
