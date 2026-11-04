# SAST, analyse de l'image Docker et chaîne de livraison : explication technique

Public visé : un ingénieur qui veut comprendre **exactement ce qui a été fait, avec quel outil, comment, et ce qui ne l'a pas été**.
Dernière mise à jour : 4 novembre 2026. Fichiers concernés : `eslint.config.js`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `Dockerfile`, `docker-compose.yml`, `SECURITY.md`.

---

## 1. Vocabulaire : cinq familles d'analyse, cinq questions différentes

| Famille | Question posée | On analyse… | Outil ici | Statut |
|---|---|---|---|---|
| **SAST** (Static Application Security Testing) | « Mon **code** contient-il une faille ? » | le code source, **sans l'exécuter** | `eslint-plugin-security` (rapide, local) + **CodeQL** (profond, GitHub) | en place |
| **SCA** (Software Composition Analysis) | « Mes **dépendances** ont-elles une faille connue ? » | `package-lock.json` | `npm audit`, `npm audit signatures` | en place depuis le début |
| **Scan d'image** (container scanning) | « L'**image livrée** contient-elle des paquets vulnérables ou un secret oublié ? » | l'image Docker construite | **Trivy** (`image`) | en place dans la CI |
| **Scan de configuration** (IaC) | « Mon **Dockerfile** suit-il les bonnes pratiques ? » | `Dockerfile` | **Trivy** (`config`) | en place dans la CI |
| **DAST** (Dynamic) | « Le **service qui tourne** résiste-t-il à une attaque ? » | le service en exécution | batterie de 82 attaques (voir `docs/SECURITE.md`) | fait à la main, hors CI |

Pourquoi plusieurs familles : elles ne voient pas les mêmes choses. Un `npm audit` propre n'empêche pas une injection dans *notre* code (SAST). Un SAST propre n'empêche pas un paquet vulnérable dans l'*image* (Trivy). Aucune ne prouve que le service **démarre** en production (test de fumée de la CI).

---

## 2. SAST n°1 : `eslint-plugin-security` (analyse locale, immédiate)

### 2.1 Ce que c'est
Un plugin ESLint qui lit l'arbre syntaxique (AST) de chaque fichier et signale des **motifs dangereux** : `eval`, `child_process` avec argument variable, `new RegExp(variable)`, accès `fs` avec un chemin variable, comparaison non sûre, `obj[clé]` avec clé variable… C'est du *pattern matching* : rapide, mais **sans suivre le chemin des données** (il ne sait pas d'où vient la variable). D'où beaucoup de faux positifs.

### 2.2 Comment je l'ai branché
```bash
npm i -D eslint-plugin-security
```
```js
// eslint.config.js
import security from "eslint-plugin-security";
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,      // ← les règles de sécurité
  ...
);
```
Comme c'est dans le **lint**, il est exécuté par `npm run lint`, donc par `npm run check` et par la CI (étape `npm run lint`). Aucun nouvel outil à lancer.

Puis `"lint": "eslint . --max-warnings 0"` : le plugin ne produit que des *avertissements* ; sans ce réglage, la CI ne les verrait jamais. Avec lui, **toute nouvelle alerte fait échouer la CI**.

### 2.3 Premier résultat : 27 avertissements, 0 erreur
Je ne les ai pas désactivés en bloc : j'ai **lu le code derrière chacun** pour décider s'il s'agit d'une vraie faille.

## 3. Le tri des 27 alertes, une par une

| Règle | Fichier:ligne | Nb | Verdict | Pourquoi |
|---|---|---|---|---|
| `detect-non-literal-fs-filename` | `config/index.ts:94` (`readFileSync(JWT_PRIVATE_KEY_FILE)`) | 1 | **Acceptable** | Le chemin vient d'une variable d'environnement posée par l'**opérateur**, jamais d'un utilisateur. Suppression en ligne avec justification. |
| idem | `scripts/generate-keys.ts` (5 lignes) | 5 | Faux positif | Script lancé à la main, chemin fixe `cwd/keys`. Règle coupée pour `src/scripts/**`. |
| `detect-non-literal-regexp` | `user.repository.ts:82` | 1 | Faux positif **testé** | `new RegExp(escapeRegExp(q))` : la saisie est entièrement échappée. Un test attaque avec `(a+)+$` (motif ReDoS) et la réponse reste rapide. Suppression en ligne justifiée. |
| idem | `policies.ts:5` | 1 | Faux positif | Le domaine e-mail vient de la configuration et est échappé. |
| `detect-object-injection` | `templates.ts:26` | 1 | Faux positif | `map[c]` où `c` est limité par la regex `[&<>"']` : table d'échappement HTML. |
| idem | `random.ts:14` | 4 | Faux positif | Indices **entiers aléatoires** (`crypto.randomInt`) d'un mélange de Fisher-Yates. |
| idem | `role.service.ts:14,24` | 5 | Faux positif sauf **1 durcissement** | Clés issues de constantes (`ROLES`, `PERMISSIONS`). Mais `key in matrix[role]` accepte aussi les propriétés **héritées** (`constructor`, `__proto__`) : remplacé par `Object.hasOwn`. |
| idem | `user.repository.ts:34-35` | 2 | Faux positif mais **durcissement ajouté** | `$set[key] = value` avec des clés internes. Pour ne plus dépendre de la bonne conduite des appelants, ajout d'une **liste blanche** de champs (voir §3.2). |
| idem | `user.service.ts:58` | 1 | Faux positif | `MATRICULE_PREFIX[role]` : `role` est une énumération déjà validée. |
| idem | `validate.ts:12` | 1 | Faux positif | `req[source]` où `source` ne peut être que `"body"` ou `"query"` (type littéral). |
| toutes | `test/**` | 5 | Faux positif | Code de test. Règles de sécurité coupées pour `test/**`. |

### 3.1 Pourquoi `detect-object-injection` est désactivée
Elle déclenche sur **tout** `obj[clé]`. Ici, ses 14 alertes (toutes triées ci-dessus) sont des faux positifs. Les garder noierait les vraies alertes dans le bruit, ce qui est dangereux : on finit par ne plus regarder. Les autres règles restent actives. La décision est écrite en commentaire dans `eslint.config.js`.

### 3.2 Les deux vrais durcissements issus du tri
1. **`Object.hasOwn` à la place de `in`** (`role.service.ts`) : l'opérateur `in` remonte la chaîne de prototypes. `"constructor" in {}` vaut `true`. Cette différence est l'origine classique de la *pollution de prototype*.
2. **Liste blanche `PATCHABLE`** (`user.repository.ts`) : la fonction `toUpdate` transforme un objet « patch » en opérateurs MongoDB (`$set`/`$unset`). Elle n'accepte maintenant que 14 noms de champs connus ; tout le reste (`$where`, `__proto__`, `isAdmin`…) est **ignoré**. Test : `JSON.parse('{"firstName":"Ada","$where":"sleep(5000)","isAdmin":true,"__proto__":{"polluted":1},...}')` (le seul moyen de créer une vraie clé `__proto__`) ne laisse passer que `firstName`, `phone`, `role`, et `({}).polluted` reste `undefined`.

### 3.3 Résultat
`npx eslint .` : **0 erreur, 0 avertissement**, et `--max-warnings 0` interdit d'en laisser entrer de nouveaux. Chaque suppression en ligne (`eslint-disable-next-line … -- raison`) **porte sa justification** dans le code.

---

## 4. SAST n°2 : CodeQL (analyse profonde, sur GitHub)

### 4.1 Ce que c'est et en quoi c'est différent
CodeQL ne cherche pas des motifs : il **construit une base de données du programme** (appels, flux de données, types) puis exécute des **requêtes** qui suivent une donnée depuis une **source** (une requête HTTP, `req.body`) jusqu'à un **puits** dangereux (requête SQL/NoSQL, `eval`, écriture de fichier, réponse HTML). C'est l'analyse de **teinte** (*taint tracking*). Elle comprend, par exemple, qu'une valeur validée par zod n'est plus dangereuse, ce que le plugin ESLint ne peut pas savoir.

### 4.2 La configuration (`.github/workflows/codeql.yml`), ligne par ligne
```yaml
on: { push, pull_request, schedule: [cron "17 4 * * 1"] }   # chaque push ET chaque lundi
permissions: { contents: read }                              # par défaut : lecture seule
jobs.analyze:
  permissions: { contents: read, security-events: write, actions: read }   # droit d'écriture limité à CE travail
  steps:
    - actions/checkout@<SHA>                                  # code
    - github/codeql-action/init@<SHA>   languages: javascript-typescript, queries: security-extended
    - github/codeql-action/analyze@<SHA>
```
- `security-extended` : jeu de requêtes plus large que celui par défaut (plus de détections, un peu plus de bruit).
- `security-events: write` : nécessaire pour publier les résultats dans **Security → Code scanning**.
- Le lundi : de nouvelles requêtes sortent régulièrement et peuvent révéler d'anciennes failles dans un code qui n'a pas changé.
- Installé dans **les deux dépôts** (backend et front React).

### 4.3 Où lire les résultats
Dépôt GitHub → **Security → Code scanning**. Chaque alerte indique le fichier, la ligne et le **chemin de la donnée** (source → puits). Une alerte peut être *corrigée*, *rejetée* (faux positif, avec raison) ou *acceptée*.

---

## 5. Analyse de l'image Docker : Trivy

### 5.1 Ce que Trivy examine dans l'image construite
1. **Paquets du système** (Alpine : `apk`) : bibliothèques C, `busybox`, `openssl`… connus vulnérables ?
2. **Dépendances applicatives** (`node_modules` de l'image) : même base de données que `npm audit`, mais sur ce qui est **réellement dans l'image**.
3. **Secrets oubliés** dans les couches (clés privées, jetons) : Trivy les cherche par motifs.
4. **Configuration** (`trivy config`) : le `Dockerfile` respecte-t-il les bonnes pratiques (utilisateur non root, `HEALTHCHECK`, pas de `ADD` distant…) ?

### 5.2 Les deux étapes ajoutées à `ci.yml` (travail `docker`, après `docker build`)
```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.57.1 image \
  --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --no-progress smartcampus-user-service

docker run --rm -v "$PWD":/w aquasec/trivy:0.57.1 config \
  --severity HIGH,CRITICAL --exit-code 1 --no-progress --skip-dirs /w/node_modules --skip-dirs /w/dist /w
```
| Option | Rôle | Pourquoi ce choix |
|---|---|---|
| `-v /var/run/docker.sock` | Trivy lit l'image que le job vient de construire | pas besoin de la publier dans un registre |
| `--severity HIGH,CRITICAL` | ignore LOW/MEDIUM | on bloque sur ce qui compte ; sinon le bruit rend la CI inutilisable |
| `--ignore-unfixed` | ignore les failles **sans correctif publié** | on ne fait pas échouer la CI pour quelque chose qu'on ne peut pas corriger |
| `--exit-code 1` | code de sortie 1 s'il y a une alerte | c'est ce qui fait **échouer** l'étape (sans lui, Trivy affiche et réussit) |
| `trivy:0.57.1` | version épinglée | un scanner qui change tout seul changerait les résultats |

### 5.3 Ce que j'ai pu vérifier **sans Docker** (Docker Desktop est arrêté sur ce PC)
Je n'ai pas pu lancer l'image ni Trivy en local. J'ai vérifié ce qui est vérifiable :
- **Simulation de l'étape `deps` du Dockerfile** dans un dossier neuf : `npm ci --omit=dev --ignore-scripts` → **159 paquets**, **0 vulnérabilité**, puis démarrage du build de production avec `/ready` = UP et **connexion de l'admin = 200**, 0 erreur dans le journal.
- **Syntaxe YAML** de tous les workflows et du compose (parser `yaml`) : valide.
- Le premier vrai résultat de Trivy vient de la **CI GitHub** (voir §8).

---

## 6. Durcissement du Dockerfile et du conteneur

| Mesure | Fichier | Menace couverte | Comment c'est fait |
|---|---|---|---|
| **Image de base épinglée par digest** | `Dockerfile` (3 `FROM`) | une étiquette comme `node:22-alpine` est **mobile** : le même Dockerfile peut produire une image différente demain | `FROM node:22-alpine@sha256:fe4f6d…9914`. Le digest est celui de l'**index multi-architectures**, lu sur le registre Docker Hub (API officielle). |
| **`npm ci --ignore-scripts`** | `Dockerfile` | un paquet compromis exécute du code à l'installation (`postinstall`) | Un inventaire de l'arbre de production a trouvé **2 scripts** : `protobufjs` (inoffensif) et **`@scarf/scarf`** (arrivé via `swagger-ui-dist`) qui **envoie de la télémétrie d'installation vers un serveur externe**. Le service fonctionne sans eux (preuve §5.3). |
| `ENV SCARF_ANALYTICS=false` | `Dockerfile` | même télémétrie à l'exécution | variable officielle de désactivation |
| Utilisateur non root, `HEALTHCHECK`, `--omit=dev`, build en 3 étapes | `Dockerfile` | élévation de privilèges ; code de test et outils de build dans l'image | déjà en place |
| `read_only: true` + `tmpfs: /tmp` | `docker-compose.yml` | un attaquant qui exécute du code ne peut rien écrire dans l'image | le service n'écrit nulle part (journaux sur la sortie standard, clés dans l'environnement) |
| `cap_drop: [ALL]` | idem | capacités Linux inutiles (ouvrir des sockets bruts, changer des propriétaires…) | un service web n'en a besoin d'aucune (port 4001 > 1024) |
| `security_opt: [no-new-privileges:true]` | idem | un binaire setuid qui élève ses droits | interdit toute élévation |
| `init: true`, `mem_limit: 512m`, `pids_limit: 256` | idem | zombies, signaux mal gérés, épuisement mémoire ou « fork bomb » | limites de ressources |
| `keys/`, `*.pem`, `*.key`, `.env.*`, `coverage/` | `.dockerignore`, `.gitignore` | une clé ou un secret copié dans l'image / commité | motifs ajoutés |
| Ports liés à `127.0.0.1` | `docker-compose.yml` | MongoDB sans authentification joignable du réseau | déjà en place |

**Contrepartie assumée de l'épinglage par digest** : l'image de base ne se met plus à jour toute seule. Quand Alpine ou Node corrige une faille, il faut **changer le digest**. Le scan Trivy de la CI est le **signal** : il passe au rouge dès que l'image épinglée contient une faille corrigeable. Procédure :
```bash
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
  https://registry-1.docker.io/v2/library/node/manifests/22-alpine | grep -i docker-content-digest
# remplacer le sha256 dans les 3 lignes FROM du Dockerfile, pousser, vérifier que la CI reste verte
```

---

## 7. Chaîne de livraison (CI/CD) : durcissement issu de l'audit DevSecOps

Un agent DevSecOps indépendant (lecture seule) a relu workflows, Dockerfile, compose, historique git (secrets), dépendances et processus. Résultats :

| Constat | Sévérité | État |
|---|---|---|
| Actions GitHub épinglées par **étiquette** modifiable (`@v4`) | Moyenne | **Corrigé** : épinglées par **SHA de commit** (`checkout`, `setup-node`, `codeql-action`), avec la version en commentaire. SHA lus avec `git ls-remote` sur le dépôt de chaque action. *Contrepartie* : à rafraîchir à la main (Dependabot est désactivé). |
| Aucune durée maximale par travail | Basse | **Corrigé** : `timeout-minutes` (15 ; 30 pour CodeQL) |
| `persist-credentials` actif par défaut dans `checkout` | Basse | **Corrigé** : `persist-credentials: false` |
| Test de fumée : `curl \| grep` peut masquer un échec de `curl` (GitHub n'active **pas** `pipefail` par défaut) | Basse | **Corrigé** : `set -euo pipefail`. *Cela m'a fait corriger une phrase fausse de `docs/CI.md`.* |
| Ni SAST ni scan d'image dans la CI | Moyenne | **Corrigé** : CodeQL + Trivy |
| Paquets installés non vérifiés | Basse | **Corrigé** : `npm audit signatures` (392 paquets backend, 503 front avec signatures vérifiées) |
| Image de base non épinglée | Moyenne | **Corrigé** : digest |
| Scripts d'installation (`@scarf/scarf`) | Moyenne | **Corrigé** : `--ignore-scripts` |
| Durcissement d'exécution du conteneur | Moyenne | **Corrigé** : `read_only`, `cap_drop`, `no-new-privileges`, limites |
| `.gitignore` / `.dockerignore` incomplets | Basse | **Corrigé** |
| Pas de `SECURITY.md` ni `CODEOWNERS` | Moyenne | **Corrigé** (les deux dépôts) |
| Liste blanche des champs de mise à jour | Basse | **Corrigé** (§3.2) |
| Front : pas de contrôle de formatage en CI | Basse | **Corrigé** : `format:check` |
| **Secrets dans l'historique git** (deux dépôts, tout l'historique) | — | **Aucun** trouvé |
| Dépendances de production vulnérables | — | **0** (backend et front) |
| `.npmrc` du front : `legacy-peer-deps=true` | Moyenne | **Accepté, documenté** : sans cela, `npm ci` échoue (`eslint-plugin-jsx-a11y` ne déclare pas `eslint 10`). Risque de qualité de build, pas de nouvelle surface d'attaque. À retirer quand le plugin sera compatible. |
| Version de Node non bornée (`engines`) | Moyenne | **Non fait volontairement** : ton PC utilise Node 24, une contrainte `>=22 <23` l'empêcherait de travailler. À décider ensemble. |
| Fichiers `qc` et `query` à la racine du backend | Basse | **Non touchés** (consigne de la passation) ; contenu : 9 octets, vraisemblablement des artefacts de redirection shell |

---

## 8. Résultats des premiers runs (GitHub)

| Analyse | Dépôt | Résultat |
|---|---|---|
| CI `check` (lint `--max-warnings 0`, types, build, audit, signatures, tests, couverture) | backend | succès |
| CI (lint, types, format, tests, build, audit, signatures) | front | succès |
| CodeQL (`security-extended`) | backend et front | analyse terminée en succès. *Je n'ai pas lu la liste des alertes (onglet Security → Code scanning) : « succès » signifie que l'analyse a tourné.* |
| **Trivy sur l'image** | backend | **a trouvé 6 vulnérabilités HIGH corrigeables**, toutes dans `npm` (livré avec l'image Node), aucune dans l'application |

**Ce que Trivy a trouvé** : `brace-expansion 2.0.2`, `ip-address 10.1.0`, `pacote 19.0.2` et `20.0.1`, `picomatch 4.0.3`, `sigstore 3.1.0`. `npm ls --omit=dev` n'en montre aucun dans l'arbre de production de l'application ; ils appartiennent à npm lui-même et à corepack.

**Ce que j'ai fait** : retiré npm, npx, corepack et yarn de l'**image finale** (`RUN rm -rf …`, voir le Dockerfile). Le service n'en a pas besoin (`CMD ["node", …]`, sonde `wget`), et cela supprime aussi la possibilité d'installer des outils depuis un shell dans le conteneur. Ce n'est pas un contournement : la surface vulnérable n'existe plus, au lieu d'être masquée par un `.trivyignore`.

**Reste à confirmer** : le run GitHub qui suit cette correction (l'image n'a pas pu être construite ni scannée en local, Docker étant arrêté). Voir `docs/PROBLEMES-ET-SOLUTIONS.md` n° 6.

---

## 9. Rejouer et lire les analyses

```bash
npm run lint                  # SAST local : 0 avertissement toléré
npm run check                 # lint + types + tests (78)
npm audit --omit=dev --audit-level=high   # SCA
npm audit signatures          # authenticité des paquets
```
Sur GitHub : onglet **Actions** (CI, Trivy), onglet **Security → Code scanning** (CodeQL).
Si Trivy échoue : lire la table des failles (paquet, version installée, version corrigée), puis soit mettre à jour le digest de l'image de base (§6), soit mettre à jour la dépendance, soit, en dernier recours et avec une date d'expiration, l'ajouter à un fichier `.trivyignore` en écrivant **pourquoi**.
Si CodeQL signale quelque chose : suivre le **chemin de la donnée**, corriger, ou rejeter l'alerte en indiquant la raison (« faux positif : validé par zod en amont »).

---

## 10. Limites (à ne pas présenter comme des garanties)

- **Aucun SAST ne prouve l'absence de faille.** `eslint-plugin-security` est un outil de motifs ; CodeQL est bien meilleur mais ne voit pas la logique métier (par exemple « un étudiant peut-il lire le profil d'un autre ? » : c'est ce que vérifient les tests d'autorisation et la batterie de 82 attaques).
- **Trivy dépend de sa base de vulnérabilités** : une faille non encore publiée n'est pas détectée.
- **L'image n'a pas été analysée en local** (Docker arrêté) : sa première analyse réelle est celle de la CI.
- **Le digest épinglé vieillit** : sans entretien, on livre une image de base de plus en plus ancienne (le scan Trivy est le garde-fou, pas un remède).
- **Dependabot est désactivé** : plus aucune mise à jour automatique des dépendances ni des actions. À compenser par une revue mensuelle (`npm outdated`, SHA des actions, digest).
- **Rien n'empêche encore de pousser du code rouge** : tant qu'aucune règle de protection de branche n'exige que la CI soit verte, elle informe sans bloquer.

## 11. Réglages GitHub que seul le propriétaire du dépôt peut faire
1. **Double authentification (2FA)** sur ton compte GitHub.
2. **Secret scanning** et **push protection** (Settings → Code security) : bloque un `git push` qui contient une clé ou un jeton.
3. **Private vulnerability reporting** (même page) : active le lien de signalement cité par `SECURITY.md`.
4. **Ruleset de branche** sur `FarahBack` et `FarahFront` : interdire force-push et suppression, exiger que les contrôles `check`, `docker` et `analyze` soient verts (sans exiger de pull request, pour garder une seule branche).
5. Éventuellement : commits signés (`required_signatures`).

## 12. Glossaire
- **AST** : arbre syntaxique d'un fichier. **Taint tracking** : suivi d'une donnée non fiable de sa source à un puits dangereux.
- **Faux positif / faux négatif** : alerte à tort / faille non détectée.
- **Digest** (`sha256:…`) : empreinte du contenu d'une image ; contrairement à une étiquette, elle ne change jamais.
- **SBOM** : inventaire de tout ce qu'il y a dans une image (non fait ici ; prochaine étape logique).
- **Chaîne d'approvisionnement** (*supply chain*) : tout ce que ton build tire de l'extérieur (paquets, actions, images).
- **Moindre privilège** : ne donner à un programme, un jeton ou un travail que les droits nécessaires.
