# Note à l'équipe : intégration des modules avec le user-service

Le **module Utilisateurs** est réel (Node.js + MongoDB). Les 5 autres modules s'affichent encore avec des données fictives. Cette note dit ce que chaque service doit fournir pour s'intégrer, et les décisions à confirmer.

## 1. Règles communes à tous les services

1. **Un service = un dépôt = une base de données.** Ne lisez jamais la base d'un autre service.
2. **Vérifiez le JWT** envoyé dans `Authorization: Bearer <jeton>` avec le **même `JWT_SECRET`** que le user-service (à échanger hors git). Le jeton contient `sub` (matricule), `name`, `role` (`student`, `teacher`, `admin`).
3. **Vérifiez le rôle vous-mêmes** : renvoyez 403 si le rôle n'a pas le droit. Ne vous fiez jamais au front.
4. **Format d'erreur identique** : `{ "message": "...", "code": "...", ... }` avec les statuts du README de votre module (401, 403, 404, 409, 422). Le front lit `code` et `details`.
5. **Routes et noms de champs exactement** comme dans le README de votre module (`src/features/<module>/README.md` du front). Si le contrat doit changer, modifiez le README ET prévenez le front.
6. **`GET /health`** qui répond 200 `{status:"UP"}` (503 si votre base est injoignable).
7. **Un `.env` par service**, jamais dans git ; un `.env.example` versionné.
8. Modèle de structure à copier : le dépôt `SMART-COMPUS-ESPRIT-5SE3-USER-SERVICE`. Fichiers à regarder : `src/middleware/auth.js` (vérification du JWT), `src/middleware/error.js` (format d'erreur), `docs/GUIDE-INGENIEUR.md`.

## 2. Décision D1 : le catalogue est géré par l'administrateur (à confirmer)

Le contrat actuel ne contient aucune route pour **créer** des cours, des salles ou des résidences. Proposition :

| Module | Ajouter côté back | Ajouter côté front | Droit |
|---|---|---|---|
| **Académique** | `POST/PUT/DELETE /courses` (admin) avec `teacherId` et séances ; suppression refusée (409) s'il y a des inscriptions validées | Écran « Gérer les cours » (admin) | `academic.manage` |
| **Ressources** | `POST/PUT/DELETE /rooms` (admin) ; suppression refusée (409) s'il y a des réservations à venir | Écran « Gérer les salles » (admin) | `resources.manage` |
| **Résidences** | `POST/PUT/DELETE /residences` et chambres (admin) | Écran « Gérer les résidences » (admin) | `housing.assign` |
| **Vie étudiante** | Déjà prévu (`POST /clubs`, `POST /events`, admin) | À vérifier | `clubs.manage` |
| **Bibliothèque** | Déjà prévu (`POST /books`, admin) | À vérifier | `library.manage` |

Le droit `academic.manage` existe déjà dans la matrice du user-service.

## 3. Qui fait quoi (rappel)

| Acteur | Académique | Ressources | Résidences |
|---|---|---|---|
| **Admin** | Crée les cours, affecte l'enseignant, valide les inscriptions | Crée les salles, **valide** les réservations | Crée résidences/chambres, **affecte** les chambres |
| **Enseignant** | Voit ses cours, saisit les notes **de ses cours** | **Demande** une réservation de salle | — (pas d'accès) |
| **Étudiant** | S'inscrit, consulte ses notes | — (pas d'accès) | **Dépose** une demande d'hébergement |

## 4. Questions à trancher en équipe (avec l'encadrant)

1. **Emploi du temps** : c'est un affichage calculé à partir des cours. L'admin saisit-il les séances (jour, heure) en créant le cours ? **Chaque séance a-t-elle une salle ?** Si oui, il faut un `roomId` sur la séance, et le module Ressources doit bloquer la salle (ou le service académique appelle Ressources).
2. **Liste des enseignants** dans le formulaire « Créer un cours » : le service académique doit connaître les enseignants. Deux solutions : écouter l'événement `UtilisateurCréé` (RabbitMQ) pour garder sa propre copie, ou appeler `GET /users?role=teacher` (réservé à l'admin).
3. **API Gateway** : qui la fait, avec quelle technologie ? Elle route `/api/<préfixe>` vers chaque service et retire `/api`.
4. **Ports** : proposition `user-service 4001`, `academic 4002`, `resources 4003`, `housing 4004`, `student-life 4005`, `library 4006`.

## 5. Comment brancher un module au front

Quand votre service tourne, ajoutez ses préfixes dans le `.env` du **front**, sans modifier le code :
```
VITE_USE_MOCKS=false
VITE_API_BASE_URL=http://localhost:<port de la Gateway ou du service>
VITE_REAL_API_PREFIXES=/auth,/users,/roles,/login-history,/courses,/enrollments,/timetable,/grades
```
Les routes non listées gardent leurs données fictives. Le front envoie déjà le JWT à chaque requête.

## 6. Événements publiés par le user-service

Sur RabbitMQ (exchange `smartcampus.events`, type `topic`) quand `RABBITMQ_URL` est défini :

| Clé | Quand | Contenu |
|---|---|---|
| `user.UtilisateurCréé` | Création d'un compte (inscription ou admin) | `{id, email, role, name}` |
| `user.RôleModifié` | Changement de rôle | `{id, email, previous, role, changedBy}` |

Vous pouvez vous y abonner pour tenir à jour vos propres données sans appeler le user-service.
