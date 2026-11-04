# Dépannage : la méthode, les incidents réels, les pannes d'exploitation

Trois parties : **A.** la méthode que j'ai appliquée à chaque problème technique ; **B.** les incidents réellement rencontrés pendant la construction (symptôme → diagnostic → cause → correction) ; **C.** le guide de panne en exploitation.

---

## A. La méthode (à appliquer à tout problème)

1. **Lire le message d'erreur en entier, et le citer.** Il contient presque toujours la réponse (`eacces`, `ERESOLVE`, `ENOTFOUND smoke-rabbit`). Ne pas deviner avant de l'avoir lu.
2. **Reproduire avec la commande la plus petite possible.** Un seul fichier de test plutôt que toute la suite :
   `node --import tsx --import ./test/setup.ts --test test/auth.service.test.ts`
3. **Trouver à quel niveau ça casse** (le plus bas niveau qui échoue est le coupable) :
   types (`npm run typecheck`) → unitaire → intégration → démarrage réel → Docker. Si l'unitaire passe et que le réel échoue, le problème est dans l'**environnement ou le câblage**, pas dans la règle métier.
4. **Se demander « qui a raison : le code ou le test? »** Un test rouge peut avoir une attente fausse. Cas vécu : le test attendait des `details` incomplets; le service, lui, était correct. Vérifier avec le diff exact (`actual` vs `expected`).
5. **Formuler une hypothèse et la tester, pas essayer au hasard.** Ex. « RabbitMQ échoue à cause du code ou de l'image? » ⇒ lire ses logs (`docker logs`) avant de toucher au code.
6. **Corriger la cause, pas le symptôme.** Ex. ne pas ajouter un `sleep` pour masquer un problème de timing : comprendre la précision du `iat` (secondes) et corriger la comparaison.
7. **Écrire un test qui échouerait sans la correction.** Sinon le problème reviendra.
8. **Dire ce qui n'a pas pu être vérifié.** Ex. le `docker build` n'a été validé qu'après le démarrage du démon Docker.
9. **Nettoyer** : bases temporaires, conteneurs, fichiers jetables. Et ne pas laisser d'effet de bord (voir l'incident n°12).

### Outils de diagnostic
| Besoin | Outil |
|---|---|
| Voir ce que fait le service | logs JSON (`LOG_LEVEL=debug`), chaque ligne porte `reqId` ; l'en-tête `x-request-id` de la réponse permet de retrouver *toute* la requête |
| Suivre une requête dans les dépendances | traces : `OTEL_TRACES_EXPORTER=console` (voir `src/instrumentation.ts`) |
| Mesurer | `GET /metrics` (durées, tentatives de connexion, `outbox_pending_events`) |
| Savoir si le service est prêt | `GET /ready` (`checks.mongo`, `checks.rabbitmq`, `status`) |
| Inspecter la base | `mongosh smartcampus_users` ; collections `users`, `outboxes`, `refreshtokens`, `loginevents` |
| Inspecter un conteneur | `docker logs <nom>`, `docker inspect <nom> --format '{{.State.Status}} {{.State.ExitCode}}'`, `docker exec <nom> id` |
| Types / lint | `npm run typecheck`, `npm run lint` |

---

## B. Incidents réels rencontrés pendant la construction

| # | Symptôme | Diagnostic | Cause | Correction |
|---|---|---|---|---|
| 1 | Le shell refuse un long bloc (`unexpected EOF while looking for matching '`) | Aucune sortie, aucun fichier créé (vérifié avec `find`) | Apostrophes françaises dans un *heredoc* shell | Écrire les fichiers avec l'outil d'écriture, ou un script Python dans un fichier puis l'exécuter |
| 2 | `npm install` : `ERESOLVE … peer typescript@">=4.8.4 <6.1.0" from typescript-eslint` | Lecture de la ligne `Found: typescript@7.0.2` | `typescript-eslint` ne supporte pas encore TypeScript 7 | `typescript@~5.9` (version stable, compatible avec tout l'écosystème). Ne pas forcer avec `--legacy-peer-deps`. |
| 3 | `tar: Cannot connect to C: resolve failed` | Message explicite | `tar` lit `C:` comme `hôte:chemin` (copie réseau) | Option `--force-local` |
| 4 | `tsc` : `Property 'id' does not exist on type 'Request'` | L'erreur nomme la propriété | `req.id` est ajouté par les types de `pino-http`, pas encore importés dans ce fichier | `import type {} from "pino-http"` dans `src/types/express.d.ts` |
| 5 | Réorganisation en dossiers : risque de casser des dizaines d'imports | — | Déplacer 39 fichiers à la main = erreurs garanties | **Script** qui construit la table « ancien chemin → nouveau chemin », puis réécrit chaque import relatif ; **le compilateur sert de filet** : `tsc` a rendu 0 erreur et les tests sont restés verts. Sauvegarde `tar` avant. |
| 6 | Test rouge : `Expected values to be strictly deep-equal` (`code` manquant dans `details`, puis `failedAttempts`/`max`) | Le diff montre `+ actual - expected` | **L'attente du test** était incomplète; le service renvoie bien les compteurs dont le front a besoin | Corriger le test, pas le service |
| 7 | Une trace d'erreur `pino-pretty` apparaît dans la sortie des tests | Le logger n'était pas muet | `process.env.NODE_ENV = "test"` placé **après** les `import` (hissés en tête) : la config était déjà lue en `development` | `test/setup.ts` chargé par `--import` avant tout autre module |
| 8 | `npm audit` : 3 vulnérabilités hautes | Lecture du détail JSON (paquet, plage, correctif) | `body-parser` (corrigé en mineure), `nodemailer` (majeure), `zod` (majeure) | `npm audit fix` ; `nodemailer@latest` ; migration vers zod 4 (génération JSON Schema native ⇒ `zod-to-json-schema` retiré). Les tests (47) ont validé la migration. |
| 9 | Installation OpenTelemetry : `ERESOLVE` puis dépendances énormes | `npm ls` + `du -sh` | `auto-instrumentations-node` embarque des dizaines d'instrumentations inutiles (AWS, Kafka…) | Seulement 4 instrumentations ciblées (HTTP, Express, MongoDB, amqplib) : 24 Mo, 0 vulnérabilité |
| 10 | Traces : risque que rien ne soit instrumenté **sans erreur** | En ESM, sans hook préalable, aucune instrumentation | Le module doit être chargé avant l'application | `--import ./dist/instrumentation.js` ; **vérifié en regardant la sortie** : un span `find users` partage le `traceId` du span HTTP |
| 11 | `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Message explicite | Le démon Docker n'était pas démarré | Démarrer Docker Desktop, puis relancer. Les vérifications Docker avaient été notées « non vérifiées » tant que ce n'était pas fait. |
| 12 | Après un test de démarrage réel : le compteur d'échecs de l'admin = 1 | Constaté en relisant la base | Un mauvais mot de passe avait été testé sur le **vrai** compte | Compteur remis à 0 par script ; règle : **les tests d'échec se font sur une base jetable** |
| 13 | RabbitMQ ne démarre pas : `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces` | `docker logs smoke-rabbit` puis `docker inspect` (`exited exit=1`) | Problème de droits du cookie Erlang sous Docker Desktop (Windows) — **pas le code** | Essais : variable `RABBITMQ_ERLANG_COOKIE` (échec), volume nommé + RabbitMQ 4 (échec), puis **`--user rabbitmq`** ⇒ prêt en 6 s. Pendant ce temps le service a montré son backoff (4/8/18/32/60 s) et `DEGRADED`. |
| 14 | `Write` refuse : « File has been modified since read » | — | Un script avait réécrit le fichier (imports) entre-temps | Supprimer le fichier puis le recréer, ou le relire avant d'écrire |
| 15 | Piège de timing : jeton refusé juste après une révocation | Raisonnement sur la précision | `iat` du JWT en **secondes**; révocation stockée en millisecondes ⇒ jeton « mort-né » | Révocation tronquée à la seconde, refus seulement si `iat` **strictement antérieur**; test avec attente de 1,1 s |
| 16 | Piège Mongoose : supprimer le téléphone ne fait rien | Relecture de la doc/comportement | Mongoose **ignore** les clés `undefined` dans un `update` | Le dépôt traduit `undefined` en `$unset` (`toUpdate`) ; test « supprimer le téléphone » |

**Leçon générale** : les incidents 11, 12, 13 n'auraient jamais été trouvés par les tests unitaires. Chaque niveau de la pyramide existe parce qu'il attrape une classe de problèmes que les autres ne voient pas.

---

## C. Guide de panne en exploitation

### C.1 Le service ne démarre pas
| Message / comportement | Cause probable | Action |
|---|---|---|
| `Configuration invalide : - PORT : …` | Variable d'environnement mal formée (la liste dit laquelle) | Corriger `.env` (voir `.env.example`) |
| `JWT_SECRET doit être défini en production` | `NODE_ENV=production` avec le secret par défaut | Définir un vrai `JWT_SECRET` (≥ 32 caractères aléatoires) |
| `Le port 4001 est déjà utilisé par un autre processus` | Un autre `npm run dev` tourne | Fermer l'autre terminal, ou changer `PORT` |
| `démarrage impossible : MongoDB injoignable` (sortie après ~5 s) | MongoDB arrêté / mauvaise URI / réseau | Vérifier `MONGODB_URI`, démarrer MongoDB. L'orchestrateur relancera tant que c'est KO. |
| Conteneur `unhealthy` | `/health` répond 503 : base injoignable | `docker logs`, vérifier le réseau Docker et l'URI (nom du service, pas `localhost`) |

### C.2 Erreurs côté client
| Réponse | Code | Signification |
|---|---|---|
| 401 `INVALID_CREDENTIALS` | + `failedAttempts`, `max` | Mauvais identifiants; le front affiche « il reste N essais » |
| 423 `ACCOUNT_LOCKED` | | Compte suspendu après `MAX_LOGIN_ATTEMPTS` échecs : un admin le réactive (`PATCH /users/:id/status {"status":"active"}`) |
| 403 `ACCOUNT_INACTIVE` | | Compte désactivé par un admin |
| 401 `SESSION_REVOKED` | | `logout-all` ou réinitialisation de mot de passe depuis l'émission du jeton : se reconnecter |
| 401 `INVALID_REFRESH_TOKEN` | | Jeton de rafraîchissement inconnu/expiré/rejoué (réponse volontairement générique) |
| 401 `INVALID_TOKEN` / `ACCOUNT_UNAVAILABLE` | | JWT expiré ou invalide / compte supprimé ou désactivé |
| 422 `VALIDATION_ERROR` | + `fields[]` | Corps de requête invalide (le champ fautif est indiqué) |
| 409 `EMAIL_EXISTS` / `SELF_PROTECTED` | | Doublon / un admin vise son propre compte |
| 429 | | Limite de débit sur `/auth` (100 requêtes / 15 min / IP) |
| 500 | | Erreur inattendue : le détail est **dans les logs** avec le même `x-request-id` |
| Erreur CORS dans le navigateur | | Origine absente de `CORS_ORIGINS` (en dev tout `localhost:*` est accepté) |

### C.3 Événements / RabbitMQ
| Symptôme | Diagnostic | Action |
|---|---|---|
| `/ready` = `DEGRADED`, `rabbitmq: down` | RabbitMQ injoignable | **Ne pas redémarrer le service** : les événements sont en base. Rétablir RabbitMQ; le relais se reconnecte seul. |
| `outbox_pending_events` qui ne redescend pas | Bus KO, relais bloqué, ou nack répétés | Logs `component:"outbox-relay"`; `db.outboxes.find({status:"pending"})` (voir `lastError`, `attempts`, `nextAttemptAt`) |
| Un consommateur reçoit un événement deux fois | Livraison « au moins une fois » | Normal : dédupliquer sur `messageId` (voir `docs/RABBITMQ-ET-EVENEMENTS.md` §6) |
| Aucun événement n'arrive alors que tout est « UP » | `RABBITMQ_URL` vide (événements seulement journalisés), ou la file du consommateur n'est pas liée à `user.#` | Vérifier la variable; vérifier le binding dans l'interface RabbitMQ (port 15672) |
| `getaddrinfo ENOTFOUND smoke-rabbit` | Mauvais nom d'hôte / réseau Docker différent | Mettre le service et RabbitMQ sur le même réseau Docker |

### C.4 Performance
1. `GET /metrics` : repérer la route lente (`http_request_duration_seconds` par `route`).
2. Traces : voir si le temps est dans MongoDB (span `find users` long) ou ailleurs.
3. Index : `users` indexé sur `email`, `role`, `status`; recherche par regex `q` non indexée (limite connue : au-delà de dizaines de milliers de comptes, passer au texte plein index `$text`, déjà déclaré dans le modèle).
4. Pool : `MONGO_MAX_POOL_SIZE` (20 par défaut).

### C.5 Arrêt / redéploiement
`docker stop` envoie SIGTERM : `/ready`→503 (`DRAINING`), attente `SHUTDOWN_DRAIN_MS` (5 s en production), fermeture dans l'ordre, code de sortie 0. Si l'orchestrateur tue le conteneur avant 5 s + durée des requêtes, **augmenter** son délai de grâce (`terminationGracePeriodSeconds` / `docker stop -t`) à au moins 20 s.
