# Journal des problèmes rencontrés et de leur résolution

Public visé : un ingénieur qui veut apprendre **comment on diagnostique** et pas seulement ce qui a été corrigé.
Chaque entrée suit le même schéma : **Symptôme → Cause → Résolution → Preuve → Leçon**.
Période : 3-4 novembre 2026. Les problèmes de *sécurité de l'application* (24 constats de l'audit) sont dans `docs/SECURITE.md` ; ici, ce sont les **problèmes rencontrés en travaillant** : outils, CI, git, tests.

## Vue d'ensemble

| # | Problème | Gravité | Origine | État |
|---|---|---|---|---|
| 1 | CI backend rouge (e-mail « CI failed ») : le conteneur de production refusait de démarrer | Haute | **Mon erreur** (règle ajoutée + même réglage forcé dans la CI) | Résolu |
| 2 | `npm ci` du front échoue (conflit `eslint 10` / `jsx-a11y`) | Haute | Existant avant mon travail | Résolu |
| 3 | Dix branches « robot » et e-mails d'échec en rafale | Moyenne | Dependabot (config existante) | Résolu |
| 4 | Un faux contrôle que j'avais écrit dans la CI du front | Moyenne | **Mon erreur** | Résolu (retiré) |
| 5 | Phrase fausse dans `docs/CI.md` sur `pipefail` | Moyenne | **Mon erreur** | Corrigé |
| 6 | Trivy trouve 6 vulnérabilités HIGH dans l'image (dans npm, livré avec Node) | Haute | Image de base | Correction poussée, **à confirmer par le run** |
| 7 | Scripts d'édition refusés par le shell (guillemets, heredoc) | Basse | Outil | Résolu |
| 8 | Test « logout-all » qui semblait révéler une faille | Moyenne | Test mal posé | Résolu (comportement voulu) |
| 9 | Deux tests unitaires en échec (égalité stricte, collision de matricules) | Basse | Tests | Résolu |
| 10 | Pas de navigateur disponible (extension Chrome non connectée) | Moyenne | Environnement | Contourné |
| 11 | Le front a été réorganisé pendant mon travail (chemins changés) | Moyenne | Travail parallèle | Résolu |
| 12 | Serveur de développement arrêté « manque de mémoire » | Basse | Environnement | Non relancé (consigne) |
| 13 | Mon `SECURITY.md` aurait fait échouer le contrôle de format du front | Basse | **Mon erreur** | Résolu avant le push |
| 14 | `npm audit fix` impossible (ERESOLVE) pour mettre à jour `zod` | Basse | Dépendances | Contourné puis réglé par `.npmrc` |
| 15 | 27 alertes SAST à trier | Moyenne | Nouvel outil | Triées, 0 faux accepté en silence |
| 16 | Docker Desktop arrêté : image non testable en local | Moyenne | Environnement | Simulé partiellement |
| 17 | Suppression de branches distantes bloquée, puis commande coupée en deux | Basse | Contrôle de sécurité + saisie | Faite par toi |
| 18 | Attendre la CI : `sleep` bloqué | Basse | Outil | Contourné (moniteur) |
| 19 | Avertissements de fins de ligne (LF/CRLF) à chaque `git add` | Basse | Windows + git | **Non résolu** |
| 20 | Avertissement GitHub : actions en Node 20 obsolète | Basse | Plateforme | **À suivre** |

---

## A. Problèmes de la CI

### 1. CI backend rouge : le conteneur de production refusait de démarrer
- **Symptôme** : e-mail « CI failed ». Le travail `check` (lint, types, tests…) était **vert** ; le travail `docker` était rouge à l'étape *Smoke test*.
- **Enquête** :
  1. L'interface publique de GitHub (le dépôt est public) a montré quelle étape échouait.
  2. Les journaux GitHub demandent une connexion (403) : impossible de lire l'erreur.
  3. **Reproduction locale** du test de fumée : build de production, mêmes variables, mêmes commandes, shell en mode strict.
  4. Le serveur ne démarrait pas : `Configuration de production refusée : COOKIE_SECURE ne doit pas être désactivé en production`.
- **Cause** : j'avais ajouté une règle « en production, les cookies doivent être `Secure` » **et**, dans le même temps, écrit `-e COOKIE_SECURE=false` dans la CI et dans `docker-compose.yml`. Le conteneur obéissait à la règle… et refusait de démarrer.
- **Résolution** : retrait du `COOKIE_SECURE=false` des deux fichiers (Chrome et Firefox acceptent les cookies `Secure` sur `http://localhost`).
- **Preuve** : le test de fumée rejoué en local passe (7 contrôles sur 7) ; run GitHub suivant : `check` ✅ et `docker` ✅ (commit `d8ab8c7`).
- **Leçon** : les tests unitaires ne lancent pas l'image de production ; c'est le rôle du test de fumée. **Quand on ajoute une règle de démarrage, on cherche partout où l'on forçait l'inverse.**

### 2. `npm ci` du front échoue (`ERESOLVE`)
- **Symptôme** : en préparant la CI du front, `npm ci` s'arrête : `eslint-plugin-jsx-a11y@6.10.2` exige `eslint ^3…^9`, le projet utilise `eslint 10`.
- **Cause** : conflit **déjà présent** dans le projet. En local, `npm install` est plus tolérant et masquait le problème ; `npm ci` est strict. La CI aurait échoué dès sa première étape.
- **Vérification** : `npm view eslint-plugin-jsx-a11y` : 6.10.2 est la **dernière** version et ne déclare pas `eslint 10`. Pas de correctif en amont.
- **Résolution** : fichier `.npmrc` (`legacy-peer-deps=true`) avec un commentaire qui dit pourquoi et quand le retirer ; `npm ci` rejoué : succès.
- **Contrepartie assumée** : cette option désactive la vérification des dépendances « peer » partout ; risque de qualité de build, pas de nouvelle surface d'attaque.
- **Leçon** : **rejouer `npm ci` (pas `npm install`) avant de promettre qu'une CI passera.**

### 3. Dix branches Dependabot et rafale d'e-mails
- **Symptôme** : le dépôt avait 10 branches, dont 9 `dependabot/...`, et plusieurs e-mails « CI failed ».
- **Cause** : `.github/dependabot.yml` demandait une branche **et** une pull request par mise à jour de dépendance. Chaque branche déclenchait la CI, qui échouait (mises à jour majeures comme `mongoose 9` ou `express-rate-limit 8`, qui cassent le code).
- **Résolution** : (a) `open-pull-requests-limit: 0` pour les trois écosystèmes, avec un commentaire qui explique comment réactiver ; (b) suppression des branches du robot ; (c) le garde-fou `npm audit` de la CI est conservé.
- **Contrepartie** : plus de mises à jour automatiques. Il faut une revue mensuelle (`npm outdated`, SHA des actions, digest de l'image).

### 4. Un faux contrôle écrit par moi
- **Symptôme** : j'avais ajouté à la CI du front une étape censée détecter un build « mode démonstration ».
- **Cause** : elle cherchait la chaîne `X-Auth-Mode` dans le code compilé… présente **quel que soit le mode**. Le contrôle ne pouvait rien détecter.
- **Résolution** : étape supprimée avant le premier push, plutôt que de livrer une fausse garantie.
- **Leçon** : **un contrôle qui ne peut jamais échouer est pire que pas de contrôle** : il rassure à tort. Tout nouveau contrôle doit avoir déjà échoué au moins une fois en test.

### 5. Phrase fausse dans `docs/CI.md`
- **Symptôme** : j'avais écrit que GitHub exécute les scripts avec `bash -eo pipefail` par défaut.
- **Cause** : c'est faux. Par défaut, un bloc `run:` s'exécute avec `bash -e` (sans `pipefail`) ; `pipefail` n'est actif qu'avec `shell: bash`. Corrigé grâce au rapport de l'agent DevSecOps.
- **Conséquence concrète** : un `curl … | grep -q …` dont le `curl` échoue pouvait passer pour réussi.
- **Résolution** : `set -euo pipefail` ajouté en tête du test de fumée ; `docs/CI.md` corrigé avec la mention explicite de l'erreur.

### 6. Trivy trouve 6 vulnérabilités dans l'image
- **Symptôme** : première exécution de Trivy sur GitHub : l'étape « Analyse de l'image Docker (Trivy) » échoue, `Process completed with exit code 1`, sans autre détail public.
- **Premier échec** : `Process completed with exit code 1`, sans détail. Code 1 peut vouloir dire « vulnérabilités trouvées » ou « erreur d'exécution » ; le journal demande une connexion GitHub et Docker est arrêté sur le PC, donc pas de reproduction locale.
- **Démarche** : plutôt que de deviner, rendre la CI **lisible**. Trivy écrit un rapport JSON, un script (`.github/scripts/trivy-annotations.mjs`) le convertit en annotations, et un message distinct signale une erreur d'exécution. Le script a été testé en local avec un faux rapport (code 1 avec constat, code 0 sans).
- **Résultat du run suivant** (collé par toi depuis l'onglet Actions) : ce n'était **pas** une panne de Trivy mais de vraies vulnérabilités, toutes HIGH avec correctif disponible :

  | Paquet | Version dans l'image | Corrigée en | CVE |
  |---|---|---|---|
  | `brace-expansion` | 2.0.2 | 2.1.4, 3.0.6… | CVE-2026-69152 |
  | `ip-address` | 10.1.0 | 10.3.1 | CVE-2026-69192 |
  | `pacote` | 19.0.2 et 20.0.1 | 21.5.1 | CVE-2026-9496 |
  | `picomatch` | 4.0.3 | 4.0.4, 3.0.2, 2.3.2 | CVE-2026-33671 |
  | `sigstore` | 3.1.0 | 4.1.1 | CVE-2026-48815 |
- **Cause** : ces paquets **ne sont pas dans l'application**. `npm ls --omit=dev` n'en montre aucun (et `npm audit` de production donne 0). Ils sont **dans npm lui-même** (et corepack), livré avec l'image `node:22-alpine`. Vérifié sur le npm de ce PC : `pacote`, `sigstore`, `brace-expansion`, `ip-address` y figurent. Le service ne lance jamais `npm` : son `CMD` est `node …` et sa sonde de santé utilise `wget`.
- **Résolution** : plutôt que de « mettre à jour npm » (impossible : il fait partie de l'image épinglée), **retirer npm, npx, corepack et yarn de l'image finale** (`RUN rm -rf …` avant `USER node`). Double bénéfice : les 6 alertes disparaissent, et un attaquant qui obtiendrait un shell dans le conteneur ne peut plus installer d'outils.
- **Pourquoi pas `.trivyignore`** : cela aurait fait taire l'alerte sans réduire le risque. Ici la **surface elle-même** est supprimée.
- **Preuve attendue** : nouveau run GitHub, étape Trivy verte. *Si d'autres constats apparaissent (paquets du système Alpine), ils seront traités de la même façon : comprendre d'où ils viennent avant de choisir.*
- **Leçon** : **un outil de sécurité en CI doit expliquer ses échecs**, sinon l'équipe finit par le désactiver. Et une alerte sur une dépendance qu'on n'utilise pas se règle en **retirant** la dépendance, pas en la masquant.

---

## B. Problèmes d'outillage et de méthode

### 7. Scripts d'édition refusés par le shell
- **Symptôme** : `unexpected EOF while looking for matching '` ; la commande entière était rejetée, rien n'était appliqué.
- **Cause** : guillemets et apostrophes imbriqués dans un long script Python passé en « heredoc » au shell.
- **Résolution** : écrire le script dans un **fichier** (outil d'écriture), puis l'exécuter. Plus aucun échec de ce type ensuite. Cette règle est notée dans la skill `security`.

### 8. Le test « logout-all » qui semblait révéler une faille
- **Symptôme** : après `logout-all`, une requête avec l'ancien jeton réussissait encore (200 au lieu de 401).
- **Enquête** : le test appelait `logout-all` **dans la même seconde** où le jeton avait été émis. Le code compare `iat < tokensValidAfter` au niveau de la **seconde** (le `iat` d'un JWT est en secondes), volontairement : un jeton émis juste après une réinitialisation ne doit pas naître déjà mort.
- **Preuve** : avec 2 secondes d'attente, le jeton d'accès **et** le jeton de rafraîchissement sont refusés (`SESSION_REVOKED`, `INVALID_REFRESH_TOKEN`).
- **Résolution** : test corrigé ; le comportement est documenté (`docs/SECURITE.md` §7).
- **Leçon** : avant de crier à la faille, **vérifier que le test mesure bien ce qu'il croit mesurer**.

### 9. Deux tests unitaires en échec
- **(a) Égalité stricte** : `assert.rejects(…, { details: { code: "ACCOUNT_LOCKED" } })` échouait car `details` contenait aussi `lockedUntil` (champ ajouté). Remplacé par une fonction de validation qui vérifie le genre, le code **et** la présence de la date.
- **(b) Collision de matricules** : le compte de test « Bob » recevait le matricule `ETU-2026-0001`, **identique** à celui d'Alice dans les doublures ; la mise à jour tombait sur le mauvais compte et le test échouait de façon trompeuse. Résolu en donnant à Alice un matricule distinct. **Le code de production était correct dans les deux cas.**

### 10. Pas de navigateur disponible
- **Symptôme** : l'extension Chrome n'était pas connectée ; impossible de cliquer dans l'interface.
- **Contournement** : exécution du **vrai `client.ts` du front** via le chargeur de modules de Vite, contre un vrai service, avec un faux `localStorage` et un **pot de cookies** simulé (y compris l'en-tête `Origin`). 13 vérifications : cookies `httpOnly`, rafraîchissement automatique, requêtes simultanées, expiration, déconnexion.
- **Limite honnête** : les **écrans** (redirections, messages) n'ont pas été vus dans un navigateur.

### 11. Le front a été réorganisé pendant mon travail
- **Symptôme** : `src/api/client.ts` introuvable ; les fichiers étaient devenus `src/shared/api/client.ts`, `AuthProvider.tsx`, etc.
- **Cause** : tu avais commité une refonte d'architecture (et Prettier) entre-temps. Mon script d'édition a échoué **avant d'écrire quoi que ce soit** (vérification d'existence), donc rien n'a été abîmé.
- **Résolution** : relecture de l'état réel, réapplication sur les nouveaux chemins, passage de Prettier. **Leçon** : relire l'état courant avant d'éditer quand quelqu'un d'autre travaille en parallèle.

### 12. Serveur de développement arrêté pour manque de mémoire
- **Symptôme** : ton `npm run dev` a été arrêté automatiquement (« système à court de mémoire »).
- **Décision** : ne **pas** le relancer sans demande (consigne du système), et te l'expliquer. Le serveur était sain : sa dernière requête avait répondu 200.

### 13. `SECURITY.md` aurait fait échouer le front
- **Symptôme** : `npm run format:check` signalait mon fichier `SECURITY.md` (Prettier vérifie aussi les `.md`).
- **Cause** : j'ajoutais un contrôle de format à la CI du front sans formater mon propre fichier.
- **Résolution** : `prettier --write` avant le commit. **Évité avant le push**, grâce au rejeu local de **tous** les contrôles de la CI.

### 14. `npm audit fix` impossible pour `zod`
- **Symptôme** : `npm audit fix` échouait (`ERESOLVE`), alors que `zod` avait une faille haute (épuisement de mémoire).
- **Résolution** : `npm install zod@^4.6.7 --legacy-peer-deps` : **0 vulnérabilité** ; le conflit de fond a ensuite été réglé durablement par le `.npmrc` (entrée 2).

---

## C. SAST, image Docker, environnement

### 15. Vingt-sept alertes SAST à trier
- **Symptôme** : `eslint-plugin-security` produisait 27 avertissements.
- **Piège évité** : les désactiver en bloc. Chacune a été **lue dans le code** ; 26 étaient des faux positifs ou des cas acceptables (avec raison), 1 révélait un vrai durcissement utile (`key in obj` → `Object.hasOwn`). Une liste blanche des champs modifiables a aussi été ajoutée.
- **Garde-fou** : `--max-warnings 0` : toute **nouvelle** alerte fait échouer la CI. Détail complet : `docs/SAST-ET-IMAGE-DOCKER.md` §3.

### 16. Docker Desktop arrêté
- **Symptôme** : `failed to connect to the docker API` ; ni image ni Trivy en local.
- **Contournement** : simulation de l'étape `deps` du Dockerfile dans un dossier neuf (`npm ci --omit=dev --ignore-scripts`, 159 paquets, 0 vulnérabilité) puis démarrage du build de production (connexion admin = 200). Cela a prouvé que `--ignore-scripts` ne casse rien.
- **Découverte au passage** : `@scarf/scarf`, présent dans l'arbre de production (via `swagger-ui-dist`), **envoyait de la télémétrie d'installation vers un serveur externe** ; neutralisé par `--ignore-scripts` et `SCARF_ANALYTICS=false`.
- **Limite honnête** : l'image n'a **jamais** été lancée en local ; sa première analyse réelle est celle de la CI.

### 17. Suppression de branches distantes
- **Symptôme** : ma suppression des branches Dependabot a été **bloquée** par le contrôle de sécurité de Claude Code.
- **Décision** : ne pas contourner. Je t'ai donné la commande exacte ; tu l'as exécutée toi-même. Une première tentative a été **coupée en deux par un retour à la ligne** (seules 2 branches supprimées, le reste lancé comme des commandes inexistantes) : relevé de l'état réel avec `git ls-remote`, puis commandes redonnées sur une seule ligne.

### 18. Attendre la CI
- **Symptôme** : `sleep 150` bloqué par l'outil.
- **Résolution** : un **moniteur** qui interroge l'API GitHub à intervalle régulier et me signale chaque changement de statut, sans attente active.

### 19. Avertissements de fins de ligne : **non résolu**
- `warning: LF will be replaced by CRLF` à chaque `git add`. Windows + git convertissent les fins de ligne. Sans effet sur le fonctionnement, mais bruit dans les sorties et risque de diffs parasites.
- **Piste** : ajouter un `.gitattributes` (`* text=auto eol=lf`), non fait pour ne pas provoquer une renormalisation massive sans ton accord.

### 20. GitHub : actions bientôt forcées en Node 24 : **à suivre**
- Annotation vue dans la CI : « Node.js 20 is deprecated… forced to run on Node.js 24 : actions/checkout ». Pas d'échec aujourd'hui. À suivre quand les actions épinglées par SHA seront mises à jour (entretien manuel, Dependabot étant désactivé).

---

## Les huit leçons à retenir

1. **Reproduire en local avant de théoriser** (CI rouge → rejeu des commandes → cause en une minute).
2. **Rejouer exactement ce que la CI lancera** (`npm ci`, `format:check`, mode strict du shell) avant de pousser.
3. **Lire le code derrière une alerte** avant de la classer ; ne jamais désactiver en bloc.
4. **Un contrôle doit pouvoir échouer** ; sinon il ne protège de rien.
5. **Quand on ajoute une règle, chercher ce qui l'enfreint déjà** (`COOKIE_SECURE`).
6. **Dire ce qui n'est pas vérifié** (écrans, image en local, journaux GitHub).
7. **Les actions sensibles restent à l'humain** (suppression de branches, réglages GitHub, 2FA).
8. **Écrire ce qu'on a appris** : ce fichier, `docs/CI.md`, `docs/SECURITE.md`, et la skill `security`.

---

## Mise à jour : suite de l'affaire Trivy

Voir l'entrée 6. La correction (suppression de npm/corepack/yarn de l'image finale) est dans le commit qui suit `f113bf1` ; la confirmation vient du run GitHub suivant.
