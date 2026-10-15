# Questions / réponses pour le jury (module Utilisateurs)

Les réponses sont courtes et à la première personne : reformulez-les avec vos mots. Elles ne contiennent que ce qui est **vraiment fait** dans le projet. Les limites sont données franchement, car un jury apprécie qu'on les connaisse.

Pour les détails techniques, voir `GUIDE-INGENIEUR.md`.

---

## A. Présentation en 2 minutes

> « J'ai réalisé le **user-service**, le microservice du module Utilisateurs de SmartCampus. Il est écrit en **Node.js avec Express** et utilise **MongoDB** comme base de données.
> Il gère l'**authentification** (connexion, inscription, mot de passe oublié), les **comptes** (l'administrateur crée des enseignants avec un mot de passe temporaire envoyé par e-mail), les **rôles et permissions**, et l'**historique de connexion**.
> Il fournit un **JWT** qui contient l'identité et le rôle, que les autres services pourront vérifier sans m'appeler.
> Il est connecté au front React par une API REST en JSON. J'ai testé le tout avec 5 tests d'intégration et avec la vraie base. Les autres modules, développés par mes camarades, sont encore en données fictives et seront branchés un par un. »

---

## B. Questions sur l'architecture et les microservices

**1. Pourquoi des microservices plutôt qu'une seule application ?**
Chaque module est un métier distinct, développé par une personne différente. Avec des microservices, chacun avance dans son dépôt avec sa base, sans bloquer les autres. Un incident dans un module ne fait pas tomber les autres. Contrepartie : plus de complexité (communication entre services, API Gateway, plusieurs bases).

**2. Qu'est-ce qui fait que votre service est un microservice ?**
Il a **un seul métier** (utilisateurs), **sa propre base** (`smartcampus_users`) que personne d'autre ne lit, son propre dépôt, son propre `.env`, il démarre seul, et il communique par **API HTTP** et par **événements**. Il est aussi **sans état** : l'identité est dans le JWT, pas dans la mémoire du serveur.

**3. Comment les autres services savent qui est connecté ?**
Mon service signe le JWT avec un secret (`JWT_SECRET`). Les autres services reçoivent le jeton dans l'en-tête `Authorization`, le vérifient avec le même secret et lisent `sub`, `name` et `role`. Ils n'ont **pas besoin de m'appeler**.

**4. Pourquoi une base de données par service ?**
Pour l'indépendance : si un service change son schéma, aucun autre n'est cassé. Pour avoir une donnée d'un autre service, on passe par son API ou par ses événements, jamais par sa base.

**5. À quoi sert l'API Gateway ?**
C'est le point d'entrée unique : le front ne connaît qu'une adresse, et la Gateway envoie chaque route au bon service. **Elle n'est pas encore faite** : en développement, le front appelle directement mon service sur le port 4001. C'est une tâche d'équipe restante.

**6. Que se passe-t-il si votre service tombe ?**
La connexion et la gestion des comptes ne marchent plus. Les utilisateurs déjà connectés gardent un jeton valide tant qu'il n'expire pas (2 h), et les autres services continuent à le vérifier sans moi. Le front affiche « service momentanément indisponible ». La route `/health` permet de le surveiller.

**7. Pourquoi Node.js ?**
Même langage que le front (JavaScript/TypeScript) dans l'équipe, très adapté aux API qui attendent beaucoup (base de données, e-mails), car il est **asynchrone** : il ne bloque pas pendant une attente.

**8. Comment les services échangent-ils sans s'appeler directement ?**
Par des **événements** : quand un compte est créé, mon service publie `UtilisateurCréé` ; quand un rôle change, `RôleModifié`. Un autre service peut s'y abonner via RabbitMQ. **Limite :** je n'ai pas testé RabbitMQ, et sans lui les événements sont seulement écrits dans le journal.

---

## C. Questions sur MongoDB

**9. Pourquoi MongoDB et pas SQL ?**
Mes données sont des documents indépendants (comptes, événements, jetons) sans jointures complexes. MongoDB est simple à démarrer et s'intègre bien avec Node grâce à Mongoose. Honnêtement, **PostgreSQL conviendrait aussi**, car ce module est assez relationnel. Changer de base ne toucherait que le fichier des modèles et `accounts.js`, pas les routes.

**10. Quelles collections avez-vous et à quoi servent-elles ?**
`users` (comptes), `loginevents` (historique), `permissions` (matrice rôle × droit), `tokens` (codes de vérification et liens de réinitialisation), `counters` (numéros pour fabriquer les matricules).

**11. Comment évitez-vous deux comptes avec le même e-mail ?**
Par un **index unique** sur `email` dans MongoDB. Même si deux inscriptions arrivent en même temps, la base en refuse une et le service répond 409.

**12. Comment fabriquez-vous les matricules ?**
Avec un compteur par rôle incrémenté **atomiquement** (`$inc`), ce qui donne `ETU-2026-0001`, `ENS-2026-0001`, `ADM-2026-0001` sans doublon, même avec des demandes simultanées.

**13. Comment les codes de vérification expirent-ils ?**
Ils sont dans la collection `tokens` avec un index **TTL** : MongoDB supprime lui-même les documents expirés (15 min pour le code, 1 h pour le lien de réinitialisation).

**14. Où est la base et que se passe-t-il si on la perd ?**
MongoDB est installé en service Windows sur mon PC. Il n'y a pas de sauvegarde automatique : en production il faudrait des sauvegardes (`mongodump`) ou un service géré comme Atlas.

---

## D. Questions sur la sécurité

**15. Comment protégez-vous les mots de passe ?**
Je ne les stocke jamais en clair : je les **hache avec bcrypt** (à sens unique). Le hash n'est jamais renvoyé par l'API (`select: false` et suppression dans la sortie JSON). Les codes et liens de réinitialisation sont aussi stockés hachés.

**16. Qu'est-ce qu'un JWT et que contient le vôtre ?**
Un jeton signé qui prouve l'identité. Le mien contient `sub` (matricule), `name` et `role`, et expire après 2 h. La signature (HS256) empêche toute modification sans connaître le secret.

**17. Que se passe-t-il si on retire le rôle d'un utilisateur alors que son jeton est encore valide ?**
À chaque requête, mon middleware **relit le compte en base**. Le rôle et le statut qui comptent sont ceux de la base, donc le changement est immédiat. C'est un choix pour compenser la durée de vie du jeton.

**18. Comment empêchez-vous la force brute ?**
Deux protections : après **5 échecs** le compte est suspendu (423) et seul un admin le réactive ; et un **rate limit** de 100 requêtes par 15 minutes sur les routes `/auth`.

**19. Comment empêchez-vous quelqu'un de s'inscrire en administrateur ?**
L'inscription publique ne lit pas le rôle : elle crée **toujours un étudiant** (le schéma de validation supprime tout champ inconnu). Un admin est créé par un autre admin, ou avec l'outil en ligne de commande.

**20. Pourquoi « mot de passe oublié » répond toujours OK ?**
Pour ne pas révéler quelles adresses ont un compte. Sinon un attaquant pourrait tester des e-mails.

**21. Comment fonctionne le mot de passe temporaire ?**
L'admin crée le compte, le service génère un mot de passe aléatoire (tirage cryptographique) et l'envoie par e-mail. Le compte est marqué `mustChangePassword` : l'utilisateur doit choisir son propre mot de passe, **différent du temporaire**, avant d'accéder au reste de l'application.

**22. Pourquoi valider les données côté backend alors que le front le fait déjà ?**
Le front peut être contourné (outil comme Postman). Le backend est la seule protection fiable, donc il revalide tout avec **zod**.

**23. Comment gérez-vous les droits ?**
Trois rôles (`student`, `teacher`, `admin`) vérifiés par des middlewares : `authenticate` (connecté ?), `requireAdmin`, `selfOrAdmin` (soi-même ou admin). Il existe aussi une **matrice de permissions** (13 droits) modifiable par l'admin. **Limite :** mon service stocke la matrice mais ce sont les **autres services** qui doivent l'appliquer.

**24. Qu'est-ce qui n'est pas encore sécurisé ?**
Pas de refresh token ni de révocation immédiate d'un jeton volé, secret JWT partagé (HS256) alors qu'en production on préférerait une clé publique (RS256), pas de double authentification, pas de journal d'audit des actions admin, et il faut un vrai `JWT_SECRET` en production.

---

## E. Questions sur le lien backend ↔ frontend

**25. Comment le front et le back communiquent ?**
En **HTTP et JSON**. Le front (React, port 5173) appelle mon API (port 4001). Toutes les requêtes passent par un **client unique** (`src/api/client.ts`) qui ajoute le JWT et normalise les erreurs.

**26. Qu'est-ce que le « contrat d'API » ?**
Le fichier `README.md` du module côté front liste chaque route, ses champs et ses erreurs. J'ai écrit le backend pour **respecter exactement** ce contrat, ce qui permet de brancher sans réécrire les pages.

**27. Comment le front affiche « il reste 3 essais » ?**
Mon backend renvoie `{ message, code, failedAttempts, max }` dans la réponse d'erreur 401. Le client du front garde ce JSON dans `ApiError.details`, et la page de connexion le lit.

**28. C'est quoi le CORS et pourquoi en avez-vous besoin ?**
Le front et le backend ont deux adresses différentes (ports 5173 et 4001). Le navigateur bloque par sécurité ces appels, sauf si le backend dit explicitement qu'il accepte ce site. C'est le rôle de `cors()` dans `app.js`.

**29. Qu'avez-vous dû corriger dans le front pour que cela marche ?**
Trois problèmes : un `useEffect` **écrasait le vrai JWT par un faux** (le backend aurait répondu 401 partout) ; les **filtres de recherche** n'étaient pas envoyés au serveur ; et les modules de mes camarades appelaient un backend inexistant (j'ai ajouté un routage par préfixes, pour que seules mes routes aillent au vrai backend).

**30. Les autres modules fonctionnent-ils avec le vrai backend ?**
Non, ils utilisent encore des **données fictives**. Seul le module Utilisateurs est réel. Chaque camarade ajoutera ses routes dans `VITE_REAL_API_PREFIXES` quand son service sera prêt.

---

## F. Questions sur la qualité et le travail réalisé

**31. Comment avez-vous testé ?**
Avec **5 tests d'intégration** (`npm test`) sur une MongoDB en mémoire : création d'un enseignant avec mot de passe temporaire, droits par rôle, inscription publique, verrouillage après 5 échecs avec réactivation, protection de l'admin et matrice de permissions. J'ai aussi testé en conditions réelles : vraie base, vrais e-mails Gmail, et préflight CORS. **Limite :** je n'ai pas de tests unitaires ni de tests automatiques de l'interface.

**32. Comment sont envoyés les e-mails ?**
Avec Nodemailer via un compte Gmail (mot de passe d'application). Les e-mails sont en HTML aux couleurs de SmartCampus. Si l'envoi échoue, le compte est quand même créé et l'erreur est journalisée.

**33. Pourquoi le lien dans l'e-mail pointe vers `localhost` ?**
Parce que le front n'est pas déployé : il tourne seulement sur mon PC. Le bouton utilise la variable `FRONTEND_URL` ; en la remplaçant par l'adresse publique, tous les liens sont corrects sans toucher au code.

**34. Quel problème technique avez-vous rencontré et résolu ?**
Un défaut d'**index unique manquant** sur les permissions : deux instances lancées en même temps avaient créé des doublons, et MongoDB avait refusé de construire l'index sans le dire. J'ai nettoyé les doublons et modifié le démarrage pour construire les index **avant** toute insertion.

**35. Qui peut créer les cours et les salles ?**
C'est une décision que j'ai proposée et qui reste **à valider** avec l'encadrant : l'**administrateur** gère le catalogue (cours, salles, résidences), l'**enseignant** saisit les notes de ses cours et réserve des salles, l'**étudiant** s'inscrit. J'ai ajouté le droit `academic.manage`. Les écrans et routes de création sont à faire par les modules concernés.

**36. Que feriez-vous avec plus de temps ?**
Un refresh token avec révocation, un journal d'audit des actions admin, la double authentification, le pattern **outbox** pour ne jamais perdre un événement, la pagination de la liste des comptes, des tests unitaires, un `docker-compose` global, l'API Gateway, et le déploiement avec un vrai domaine.

**37. Quelle est la plus grande limite aujourd'hui ?**
Un seul des six modules est réel, et il n'y a ni Gateway ni déploiement. Le user-service est complet et testé, mais l'intégration avec les autres services reste à faire en équipe.

---

## G. Pièges à éviter devant le jury

- Ne dites pas « tout est connecté » : seul le module Utilisateurs est réel.
- Ne dites pas « c'est sécurisé à 100 % » : citez les limites (question 24).
- Si on vous demande de montrer, préparez avant : MongoDB lancé, backend (`npm run dev`) et front (`npm run dev`) démarrés, et une session déconnectée pour montrer la page d'accueil.
- Gardez la liste de vos comptes de test : `yaichfarah1@gmail.com` (admin), et créez un enseignant pendant la démonstration pour montrer le mot de passe temporaire par e-mail.
- Si on vous pose une question hors de votre module, répondez que c'est le service d'un camarade et montrez le contrat dans son `README`.

## H. Scénario de démonstration conseillé (5 minutes)

1. Page d'accueil publique, *Se connecter* avec le compte admin.
2. *Utilisateurs → Créer un compte* (enseignant, adresse Gmail de test) : montrer l'e-mail reçu.
3. Se déconnecter, se connecter avec le mot de passe temporaire : le changement est imposé.
4. 5 mauvais mots de passe sur un compte de test : verrouillage, puis réactivation par l'admin.
5. *Rôles et permissions* : montrer la matrice et le droit `academic.manage`.
6. *Historique de connexion* : montrer les échecs enregistrés.
7. Ouvrir `http://localhost:4001/health` et expliquer le microservice.
