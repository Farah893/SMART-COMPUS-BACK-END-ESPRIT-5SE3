# Sécurité du user-service : ce qui a été fait, pourquoi, et avec quoi

Public visé : un ingénieur qui veut **comprendre** (pas seulement copier). Pour chaque mesure : *la menace*, *l'outil*, *comment il est utilisé ici* (avec le fichier), *comment le vérifier*.
Dernière mise à jour : 4 novembre 2026 (RS256 inclus). Les failles résiduelles sont listées honnêtement au §7.

---

## 1. Les cinq principes derrière toutes les décisions

1. **Défense en profondeur** : jamais une seule barrière. Exemple : un cookie volé est gêné par `httpOnly` (le JS ne le lit pas), `SameSite` (pas envoyé depuis un autre site), l'en-tête CSRF (refus côté serveur) et l'expiration courte.
2. **Échouer fermé** : en cas de doute ou de mauvaise configuration, on refuse. Le service **refuse de démarrer** en production avec un secret d'exemple (`src/config/index.ts`).
3. **Ne rien révéler à l'attaquant** : même message, même temps de réponse pour un compte inconnu, verrouillé ou désactivé. Seul le vrai titulaire (mot de passe correct) apprend pourquoi.
4. **Le serveur décide, jamais le client** : le rôle est relu en base à chaque requête ; le changement de mot de passe obligatoire est imposé par le serveur, pas seulement par l'écran du front.
5. **Moindre privilège et surface minimale** : pas de documentation d'API en production, pas de port exposé au réseau, pas de photo par URL externe, pas de protocole inutile (GraphQL, SOAP…).

Cadres de référence : **OWASP Top 10** (les 10 risques web les plus courants) et **OWASP API Security Top 10** (les mêmes, côté API : autorisation par objet, authentification cassée, consommation de ressources non limitée…).

---

## 2. Carte menace → défense

| Menace (ce que fait l'attaquant) | Défense | Où |
|---|---|---|
| Devine un mot de passe en boucle (force brute) | Limiteur par compte+IP, verrouillage temporaire, bcrypt lent | `rate-limiters.ts`, `auth.service.ts`, `password-hasher.ts` |
| Bloque exprès le compte d'un autre (déni de service) | Le verrouillage **se lève tout seul** (15 min) ; limiteur par IP+compte | `auth.service.ts` |
| Devine quels comptes existent (énumération) | Même réponse 401, hachage factice, envoi d'e-mail non bloquant | `auth.service.ts` |
| Vole le jeton avec une faille XSS | Jetons en cookies `httpOnly`, plus rien dans `localStorage` | `auth-cookies.ts`, front `client.ts` |
| Fait agir un utilisateur connecté depuis un autre site (CSRF) | En-tête `X-Auth-Mode` obligatoire + contrôle de l'origine + `SameSite` | `auth-cookies.ts` |
| Rejoue un ancien jeton de rafraîchissement volé | Rotation à chaque usage, rejeu détecté = toute la session révoquée | `session.service.ts` |
| Forge un jeton admin | **RS256** : seule la clé privée du user-service signe ; algorithme fixé, `iss`/`aud` contrôlés | `token-service.ts`, `config/index.ts` |
| Devine le code à 6 chiffres | 5 essais maximum puis le code est détruit | `auth.service.ts` |
| Inonde la boîte mail d'une victime | Délai de 60 s par destinataire + quota strict | `auth.service.ts`, `rate-limiters.ts` |
| Garde l'accès avec un mot de passe temporaire | Le serveur n'autorise que le changement de mot de passe | `auth.middleware.ts` |
| Injecte du NoSQL (`{"$ne": ""}`) ou du HTML | Validation stricte (zod), regex échappées, e-mails échappés | `validate.ts`, `policies.ts`, `templates.ts` |
| Falsifie son IP pour contourner les quotas | `TRUST_PROXY` explicite (0 par défaut) | `app.ts` |
| Uploade un faux avatar / un pixel espion / une réponse géante | Image `data:` vérifiée (signature binaire), 100 Ko, pas d'URL externe, pas de photo dans les listes | `user.dto.ts`, `user.repository.ts` |
| Se crée un compte avec l'adresse de quelqu'un d'autre | Connexion refusée tant que le code e-mail n'est pas saisi | `auth.service.ts` |
| Laisse le service sans administrateur | Garde « dernier admin actif » | `user.service.ts` |
| Lit les secrets dans les logs | Masquage des en-têtes `Authorization`, `Cookie`, `Set-Cookie` | `logging/logger.ts` |

---

## 3. Chaque outil : à quoi il sert, pourquoi, comment je l'utilise

### 3.1 `helmet` : en-têtes HTTP de sécurité
**Quoi.** Ajoute des en-têtes de réponse qui demandent au navigateur de se protéger.
**Pourquoi.** Le navigateur est plus permissif par défaut. Ces en-têtes ferment des familles d'attaques :
- `Content-Security-Policy` : n'exécuter que les scripts de notre propre origine (limite l'impact d'un XSS).
- `Strict-Transport-Security` (HSTS) : toujours HTTPS ensuite.
- `X-Content-Type-Options: nosniff` : ne pas deviner le type d'un fichier.
- `X-Frame-Options` : interdit d'afficher le site dans une iframe (clickjacking).
- `Referrer-Policy: no-referrer` : ne pas transmettre l'adresse de la page aux sites tiers.
**Ici.** `app.use(helmet())` dans `src/app.ts`. Les réponses réelles portent ces en-têtes (vérifié sur le service en marche).
**Piège évité.** `/docs` (Swagger) était monté *avant* helmet, donc sans ces en-têtes : il est maintenant **désactivé en production** (`ENABLE_DOCS`).

### 3.2 `cors` : qui a le droit d'appeler l'API depuis un navigateur
**Quoi.** Autorise ou non un site tiers à lire nos réponses.
**Pourquoi.** Sans liste blanche, n'importe quel site pourrait appeler l'API avec les cookies de l'utilisateur et lire le résultat.
**Ici.** `origin` = liste `CORS_ORIGINS` uniquement (tout `localhost` n'est accepté qu'en développement), `credentials: true` pour les cookies. La fonction `isAllowedOrigin` est **partagée** avec la protection CSRF pour avoir une seule règle (`auth-cookies.ts`).
**À retenir.** CORS protège la *lecture* des réponses ; il n'empêche pas, seul, l'*envoi* d'une requête. D'où le §4.3 (CSRF).

### 3.3 `express-rate-limit` : freiner les robots
**Quoi.** Compte les requêtes par clé (IP, IP+e-mail…) sur une fenêtre de 15 minutes et répond 429 au-delà.
**Pourquoi.** Un mot de passe de 8 caractères se devine par millions d'essais si rien ne freine. Un quota *unique* est mauvais : trop large pour la force brute, trop étroit pour un campus entier derrière une même IP.
**Ici** (`src/shared/http/rate-limiters.ts`), un limiteur **par usage** :
- connexion : 10 échecs / 15 min par **IP + compte**, et 100 par IP. `skipSuccessfulRequests` : seules les connexions **échouées** comptent, donc un campus de 3 000 étudiants derrière la même IP n'est pas bloqué ;
- inscription, code, mot de passe oublié : 10 / 15 min par IP + e-mail (anti-inondation) ;
- rafraîchissement : large (120), car le front l'appelle automatiquement ;
- changement de mot de passe : 10 / 15 min par IP + compte (un jeton volé ne permet pas de deviner le mot de passe actuel).
**Limite connue.** Le compteur est en mémoire, donc par instance. Avec plusieurs instances, il faut un magasin partagé (Redis).

### 3.4 `zod` : valider tout ce qui entre
**Quoi.** Décrit la forme exacte attendue d'une requête et rejette le reste.
**Pourquoi.** C'est la défense principale contre l'**injection NoSQL** (`{"email": {"$ne": ""}}` ferait correspondre tous les comptes) et le **mass assignment** (envoyer `"role": "admin"` à l'inscription).
**Ici.** Chaque route a son schéma (`*.dto.ts`) appliqué par `validate()`. Comme chaque champ est déclaré `string`, un objet est refusé ; les clés inconnues sont **supprimées** (le rôle envoyé à l'inscription disparaît). Les limites de taille bornent la mémoire consommée. Mots de passe : `bcrypt` ignore tout après 72 octets, on refuse donc plus long au lieu de tronquer en silence.

### 3.5 `bcryptjs` : stocker les mots de passe
**Quoi.** Fonction de hachage **volontairement lente**, avec un sel aléatoire par mot de passe.
**Pourquoi.** Si la base fuit, l'attaquant ne peut tester que quelques essais par seconde au lieu de milliards (SHA-256 seul serait trop rapide).
**Ici.** Coût `BCRYPT_ROUNDS=12` (chaque +1 double le temps). 4 en test pour aller vite. Le hash n'est jamais renvoyé : le champ est `select: false` et les DTO de sortie sont écrits champ par champ.

### 3.6 `jsonwebtoken` : le jeton d'accès
**Quoi.** Un JWT est un jeton signé : `en-tête.contenu.signature`. Le serveur vérifie la signature, sans base de données.
**Pourquoi / piège.** Un JWT ne peut pas être « annulé » avant son expiration. Trois parades ici :
1. **durée courte** (2 h par défaut ; à réduire à 15 min en production, le rafraîchissement automatique rend cela invisible) ;
2. à chaque requête, le serveur **relit le compte** : un rôle retiré ou un compte désactivé prend effet **immédiatement** ;
3. `tokensValidAfter` : « tous les jetons émis avant cette date sont morts » (déconnexion partout, réinitialisation de mot de passe).
**Signature : RS256 (asymétrique) en production.** Avec HS256, *tous* les services partagent le même secret : celui qui en compromet un peut forger un jeton administrateur pour tous les autres. Avec RS256 :
- la **clé privée** reste dans le seul user-service (`JWT_PRIVATE_KEY_FILE`, générée par `npm run keys:generate`, dossier `keys/` ignoré par git) ;
- les autres services vérifient avec la **clé publique**, téléchargée sur `GET /.well-known/jwks.json` (JWKS, RFC 7517) : un service compromis ne peut plus rien forger ;
- chaque jeton porte un `kid` (empreinte de la clé, RFC 7638), ce qui permet la **rotation** sans coupure : `JWT_PREVIOUS_PUBLIC_KEY` garde l'ancienne clé acceptée, et les deux sont publiées ;
- à la vérification, l'algorithme est **fixé côté serveur** (`algorithms: ["RS256"]`), jamais lu dans le jeton, ce qui bloque `alg: none` et la **confusion RS256→HS256** (signer en HS256 avec la clé publique, qui est publique) ; `issuer` et `audience` sont aussi contrôlés ;
- clé RSA de **3072 bits** générée, 2048 minimum exigé au démarrage ;
- en production le service **refuse de démarrer** sans clé RSA ; HS256 (`JWT_SECRET`) n'existe plus qu'en développement et en tests, et n'est jamais publié en JWKS.
Prouvé sur un vrai service : un jeton HS256 signé avec la clé publique, un jeton `alg:none` et un jeton RS256 signé par une autre clé sont tous refusés (401).

### 3.7 Cookies `httpOnly` : garder les jetons hors de portée du JavaScript
**Quoi.** Un cookie `HttpOnly` est envoyé par le navigateur mais **illisible** par le JS de la page.
**Pourquoi.** Avant, le jeton était dans `localStorage` : une seule faille XSS (un script injecté) pouvait le voler. Maintenant, même avec un XSS, le script ne peut pas lire le jeton.
**Ici** (`src/shared/http/auth-cookies.ts`) :
- `sc_access` (jeton d'accès) et `sc_refresh` (rafraîchissement) ;
- `HttpOnly` ; `Secure` (HTTPS seulement, imposé en production) ; `SameSite=Strict` ; `Path=/` ;
- **mode à la demande** : seul un client qui envoie `X-Auth-Mode: cookie` reçoit des cookies, et le corps de la réponse ne contient alors **aucun jeton** (sinon un script pourrait rappeler `/auth/refresh` et lire un jeton neuf). Les autres clients (autres services, scripts, Swagger) gardent `Authorization: Bearer`.
- à la déconnexion, les cookies sont effacés **avec les mêmes attributs** qu'à la création, sinon le navigateur les garde.

### 3.8 Protection CSRF (Cross-Site Request Forgery)
**La menace.** Un cookie est envoyé automatiquement par le navigateur, *même si la requête vient d'un site malveillant*. Un formulaire caché sur `evil.example` pourrait faire un `POST /auth/logout-all` à ta place.
**Défense en trois couches** (`assertCsrfSafe`) :
1. `SameSite=Strict` : le navigateur n'envoie pas le cookie depuis un autre site ;
2. toute requête qui modifie des données, authentifiée par cookie, doit porter l'en-tête **personnalisé** `X-Auth-Mode: cookie`. Un site tiers ne peut pas envoyer un en-tête personnalisé sans « pré-vérification » CORS, que notre liste blanche refuse ;
3. si le navigateur indique une `Origin`, elle doit être dans la liste blanche.
Un client `Bearer` n'est pas concerné (pas de cookie automatique, donc pas de CSRF). Testé : `test/api.test.ts` (« CSRF »).

### 3.9 Sessions longues : rotation et détection de rejeu
**Quoi.** Le jeton de rafraîchissement (30 jours) sert à obtenir un nouveau jeton d'accès. À **chaque usage**, il est remplacé.
**Pourquoi.** Si quelqu'un le vole et l'utilise, quand le vrai utilisateur l'utilise à son tour, le serveur voit un jeton **déjà consommé** : c'est un rejeu, donc **toute la famille de jetons est révoquée** (le voleur et la victime doivent se reconnecter).
**Ici** (`session.service.ts`) : stocké **haché en SHA-256** (comme un mot de passe : une fuite de la base ne donne pas de jetons utilisables) ; consommation **atomique** (deux appels simultanés : un seul réussit).

### 3.10 `crypto` (Node) : aléatoire et comparaisons sûres
- `crypto.randomInt`, `randomBytes` : aléa **cryptographique** (jamais `Math.random`) pour mots de passe temporaires, codes, liens (`random.ts`).
- `crypto.createHash("sha256")` : empreinte des codes et jetons stockés.
- `timingSafeEqual` : comparaison en temps constant du jeton `/metrics` (une comparaison `===` laisse fuiter, par le temps, le nombre de caractères corrects).

### 3.11 `mongoose` : accès base de données
**Pourquoi c'est un enjeu.** Les requêtes sont construites avec des valeurs déjà validées en `string` (zod), jamais avec un objet venu du client. La recherche utilise une regex dont l'entrée est **échappée** (`escapeRegExp`) : sinon `.*.*.*(a+)+` pourrait figer le serveur (ReDoS).
**Index** unique sur l'e-mail : empêche les doublons même en cas de course.

### 3.12 `pino` : journaux sans secrets
**Quoi.** Logs JSON structurés. L'option `redact` remplace par `[masqué]` les en-têtes `Authorization`, `Cookie` et `Set-Cookie`. Chaque requête a un `x-request-id` (une valeur du client n'est acceptée que si elle est sobre : `[\w.-]{8,64}`, sinon on en génère un : pas de pollution des journaux).

### 3.13 Docker, CI et dépendances
- Image **multi-étapes, utilisateur non root**, dépendances de production seulement, sonde de santé.
- `npm audit --omit=dev` dans la CI (échec sur vulnérabilité haute), **Dependabot** pour les mises à jour. Front : `zod` mis à jour (0 vulnérabilité).
- `docker-compose.yml` : **tous les ports liés à `127.0.0.1`** (MongoDB sans authentification et Mailpit affichant tous les codes ne doivent jamais être joignables du réseau), avertissement « développement uniquement ».
- CI : le test de fumée tourne en production avec un mot de passe admin fort et vérifie que `/docs` répond **404**.

---

## 4. Les mécanismes expliqués pas à pas

### 4.1 Connexion sans fuite d'information (`auth.service.ts`, `login`)
Avant : un e-mail inconnu répondait vite (pas de bcrypt) ; un compte connu répondait plus lentement avec `failedAttempts`. Un attaquant pouvait donc **lister les comptes**. Maintenant :
1. on cherche le compte ;
2. on compare **toujours** un hachage : celui du compte, ou un hachage factice si l'e-mail est inconnu (même durée) ;
3. mauvais mot de passe, compte inconnu, verrouillé ou désactivé → **le même 401**, au même corps JSON (testé : corps identiques) ;
4. seul le bon mot de passe révèle la raison : 423 (verrouillé jusqu'à `lockedUntil`), 403 (désactivé), 403 `EMAIL_NOT_VERIFIED`.
Conséquence assumée : le compteur « il vous reste N essais » n'existe plus (il aurait trahi l'existence du compte).

### 4.2 Verrouillage temporaire (au lieu d'une suspension permanente)
**Le problème.** « 5 échecs = compte suspendu jusqu'à un administrateur » permettait à n'importe qui de **bloquer un compte** (même l'administrateur) en échouant 5 fois à la porte. C'est un déni de service.
**La solution.** Au seuil, le compte passe `suspended` avec `lockedUntil` (15 min, `LOCKOUT_MINUTES`) et **se déverrouille seul**. Un administrateur peut toujours le lever avant. Un compte verrouillé ne compte plus d'échecs (pas d'escalade infinie).

### 4.3 Vérification d'e-mail réellement imposée
Le champ `emailVerified` existait mais **personne ne le lisait** : on pouvait créer `directeur@…` et se connecter. Maintenant l'auto-inscription pose `verificationPending: true` et la connexion est refusée tant que le code n'est pas saisi. Les comptes existants (sans ce drapeau) ne sont pas bloqués : aucune migration nécessaire. Les comptes créés par un administrateur sont de confiance (le mot de passe temporaire est livré à l'adresse).

### 4.4 Code à 6 chiffres : pourquoi 5 essais
Un code à 6 chiffres = 1 000 000 de possibilités. Avec 100 essais/15 min par IP et des milliers d'IP, c'est faisable. Chaque code a donc un **compteur d'essais** (atomique, `$inc`) : au 5ᵉ échec, **il est détruit** (il faut en redemander un). Un nouvel envoi dans les 60 s est ignoré en silence (pas d'inondation, et le lien légitime n'est pas écrasé).

### 4.5 Mot de passe temporaire : imposé par le serveur
Avant, `mustChangePassword` n'était vérifié que par l'écran du front. Un client direct (curl) pouvait utiliser tout l'API avec le mot de passe temporaire. Maintenant `authenticate` répond 403 `PASSWORD_CHANGE_REQUIRED` partout sauf : changer son mot de passe, lire son propre profil, se déconnecter.

### 4.6 Configuration de production qui échoue fermée
`config/index.ts` refuse de démarrer en production si : secret JWT < 32 caractères ou d'exemple ; mot de passe admin par défaut ou faible (< 12 caractères) ; `EXPOSE_TEMP_PASSWORD` actif ; cookies non `Secure`. Message clair listant chaque problème. Testé dans `test/security.test.ts` (processus fils).

### 4.7 `TRUST_PROXY` : ne pas croire `X-Forwarded-For` par défaut
`req.ip` sert aux quotas et à l'historique de connexion. Si le service est joignable directement et qu'on « fait confiance » au proxy, un client envoie `X-Forwarded-For: 1.2.3.4` et change d'IP à volonté : **les limiteurs ne servent plus à rien**. La valeur est donc explicite (`TRUST_PROXY=0` par défaut ; `1` derrière la Gateway, qui doit **écraser** cet en-tête).

---

## 5. Audit indépendant : les 24 constats et leur état

Un auditeur indépendant (agent en lecture seule) a relu le code back et front. Résultat et traitement :

| # | Constat | Gravité | État |
|---|---|---|---|
| S-01 | N'importe qui pouvait suspendre n'importe quel compte | Haute | **Corrigé** (verrouillage temporaire, limiteur par compte) |
| S-02 | Mot de passe admin par défaut en production ; changement forcé non imposé côté serveur | Haute | **Corrigé** (démarrage refusé + garde serveur) |
| S-03 | Secret JWT d'exemple accepté ; secret partagé HS256 | Moy.-haute | **Corrigé** : RS256 obligatoire en production, plus de secret partagé |
| S-04 | Énumération des comptes (réponses et temps) | Moyenne | **Corrigé** |
| S-05 | E-mail jamais vérifié à la connexion | Moyenne | **Corrigé** |
| S-06 | Code à 6 chiffres sans compteur | Moyenne | **Corrigé** |
| S-07 | `X-Forwarded-For` falsifiable | Moyenne | **Corrigé** (`TRUST_PROXY`) |
| S-08 | Avatars énormes, URL externes | Moyenne | **Corrigé** |
| S-09 | Mongo / Mailpit / RabbitMQ exposés par le compose | Moyenne | **Corrigé** (127.0.0.1) ; authentification Mongo à activer hors développement |
| S-10 | Pas de limite sur le changement de mot de passe | Basse-moy. | **Corrigé** |
| S-11 | Inondation d'e-mails | Basse-moy. | **Corrigé** |
| S-12 | Quota unique pour login et refresh | Basse-moy. | **Corrigé** (limiteurs séparés) ; compteur en mémoire = résiduel |
| S-13 | Rafraîchissement simultané dans deux onglets déconnecte | Basse | **Corrigé** : fenêtre de grâce de 10 s (`REFRESH_GRACE_SECONDS`) ; compromis : un rejeu dans ces 10 s n'est pas détecté |
| S-14 | Jeton sans `iss`/`aud`/algorithme fixé | Basse | **Corrigé** (`iss`, `aud`, algorithme fixé, `kid`) |
| S-15 | `NODE_ENV` par défaut = développement | Basse | **Documenté** : l'image Docker fixe `production` |
| S-16 | `/docs` et `/ready` publics | Basse | `/docs` **corrigé** ; `/ready` reste public (sondes) |
| S-17 | `X-Request-Id` non validé | Basse | **Corrigé** |
| S-18 | Données personnelles dans les logs d'événements | Basse | **Corrigé** dans les journaux (identifiant seul) ; le contenu des événements RabbitMQ reste à minimiser avec les consommateurs |
| S-19 | Historique de connexion sans purge | Basse | **Corrigé** : index TTL sur un nouveau champ (`expiresAt`, 180 jours) ; les anciens enregistrements ne sont pas purgés |
| S-20 | Rôle lu depuis `localStorage` dans l'UI | Basse | **Accepté** : l'autorisation réelle est côté serveur |
| S-21 | Jeton de réinitialisation dans l'URL | Basse | **Corrigé** (adresse nettoyée + `no-referrer`) |
| S-22 | Mode démo actif par défaut en production | Basse | **Corrigé** (build de production = vrai service) |
| S-23 | Pas de CSP côté front, `zod` vulnérable | Basse | `zod` **corrigé** ; CSP à poser sur l'hébergeur |
| S-24 | CI/hygiène, deux admins qui se rétrogradent | Info | **Corrigé en partie** (garde « dernier admin », CI durcie) ; actions GitHub à épingler par SHA |

**Ce que l'audit a confirmé comme bien fait** : conception CSRF sans contournement trouvé, autorisation vérifiée sur chaque route, pas d'injection, jetons de rafraîchissement hachés avec rotation, e-mails échappés, `/metrics` protégé, pas de `dangerouslySetInnerHTML` côté front.

---

## 6. Comment vérifier soi-même

```bash
npm run check                      # lint + typecheck + 74 tests (dont sécurité) ; couverture 96,9 % lignes / 88,2 % branches
node --import tsx --import ./test/setup.ts --test test/security.test.ts   # limiteurs + démarrage en production
npm audit --omit=dev               # dépendances de production
```
Tests parlants à lire : `test/security.test.ts` (quotas, refus de démarrer), `test/auth.service.test.ts` (verrouillage, énumération, codes), `test/api.test.ts` (CSRF, cookies, avatars, mot de passe temporaire).
Essai manuel de l'énumération : `curl` un compte inconnu et un compte connu avec un mauvais mot de passe : les corps de réponse sont identiques.

---

## 7. Risques résiduels (à ne pas présenter comme réglés)

1. **Autres services** : ils acceptent un JWT révoqué jusqu'à son expiration (la signature seule est vérifiée). Réduire la durée du jeton d'accès (15 min). Ils doivent aussi passer à la vérification par JWKS (voir `docs/NOTE-EQUIPE.md`).
2. **Gateway** : le navigateur n'envoie plus d'en-tête `Authorization` (cookies). La Gateway doit lire `sc_access`, le transmettre en `Bearer`, et **écraser** `X-Forwarded-For`.
3. **Quotas en mémoire** : par instance ; prévoir Redis dès que le service tourne en plusieurs copies.
4. **Fenêtre de grâce du rafraîchissement (10 s)** : un voleur qui rejouerait un jeton dans les 10 secondes suivant son usage légitime ne serait pas détecté (compromis standard ; réglable, 0 = strict).
5. **Anciens enregistrements d'historique** : sans `expiresAt`, ils ne sont pas purgés (seuls les nouveaux le sont) ; un nettoyage ponctuel est possible.
6. **Mongo sans authentification en développement** ; en production, authentification + réseau privé + sauvegardes chiffrées.
7. **Pas de 2FA**, pas de journal d'audit des actions administrateur.
8. **Pas de CSP côté front** (à poser par l'hébergeur), pas d'analyse de vulnérabilités du code (SAST) dans la CI.
9. **Verrouillage par compte** : l'attaquant peut encore *geler* un compte 15 min en échouant ; le limiteur par IP+compte et l'auto-déverrouillage en limitent l'effet (pas de verrouillage permanent).
10. **Aucun test d'intrusion réel** n'a été fait avant production.

---

## 8. Prochaines étapes

- **Fait : RS256 + JWKS** (§3.6). Le socle d'OIDC (jetons signés asymétriquement, clés publiées) est en place.
- **OAuth 2.0 / OpenID Connect** : ce service n'est **pas** un fournisseur OIDC (pas d'endpoints `/authorize`, `/token`, pas de document de découverte complet). Deux voies réalistes : (a) **SSO** : se connecter via le fournisseur d'identité de l'école (Microsoft Entra ID, Google Workspace…) avec le flux *Authorization Code + PKCE* ; le user-service vérifie le jeton d'identité reçu (JWKS du fournisseur), crée/relie le compte, puis émet *ses* jetons ; (b) adopter un serveur d'identité prêt à l'emploi (Keycloak…) et lui déléguer l'authentification. Dans les deux cas : jamais le flux implicite, toujours PKCE, `state` et `nonce` vérifiés, redirections exactes enregistrées.
- 2FA pour les administrateurs, journal d'audit, Redis pour les quotas, CSP.

## 9. Glossaire

- **XSS** : un script étranger s'exécute dans ta page. **CSRF** : un site étranger fait agir ton navigateur connecté.
- **IDOR / BOLA** : accéder à l'objet d'un autre en changeant un identifiant. Ici : `selfOrAdmin` / `onlySelf` sur chaque route.
- **Énumération** : deviner quels comptes existent. **Force brute** : essayer beaucoup de mots de passe. **Credential stuffing** : essayer des couples fuités ailleurs.
- **Sel (salt)** : aléa ajouté avant hachage pour que deux mots de passe identiques donnent deux hachages différents.
- **TTL** : suppression automatique à l'expiration. **Idempotent** : répéter l'opération ne change rien de plus.
- Lectures : OWASP Top 10, OWASP API Security Top 10, OWASP Cheat Sheet Series (Authentication, Session Management, CSRF Prevention, Password Storage).
