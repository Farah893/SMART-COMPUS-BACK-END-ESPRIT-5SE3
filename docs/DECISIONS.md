# Décisions d'architecture et de produit

## D1 — Qui crée les cours et les salles ? (validée)

**Contexte.** Les README des modules Académique et Ressources ne prévoyaient aucune route de création de cours (`POST /courses`) ni de salles (`POST /rooms`), aucune permission correspondante et aucun écran. Les cours et les salles n'existaient que dans les données fictives.

**Décision.** Le catalogue est géré par l'**administrateur** uniquement.

| Donnée | Créer / modifier / supprimer | Droit (matrice du user-service) |
|---|---|---|
| Cours (avec enseignant responsable) | Administrateur | `academic.manage` (nouveau) |
| Salles et équipements | Administrateur | `resources.manage` (précisé : « Gérer les salles, valider les réservations et la maintenance ») |
| Notes d'un cours | Enseignant **du cours**, ou administrateur | `academic.grades` |
| Réservation d'une salle | Enseignant, administrateur | `resources.book` |

Les droits sont des permissions de la matrice, modifiables par l'admin ; seuls les droits `users.*` de l'admin sont verrouillés.

**Conséquences.**

*user-service (fait).* Ajout de `academic.manage` à la matrice (accordé à l'admin uniquement, par défaut) ; libellé de `resources.manage` précisé. Au redémarrage, le seed insère la nouvelle permission sans écraser les choix déjà faits par l'admin.

*academic-service (à faire).*
- `POST /courses` · `PUT /courses/{id}` · `DELETE /courses/{id}` : admin. Corps : `{code, title, credits, capacity, teacherId, semester, ...}` ; 403 · 409 `COURSE_EXISTS` · 422.
- `teacherId` doit désigner un compte de rôle `teacher` (voir `GET /users`, réservé à l'admin, ou l'événement `UtilisateurCréé`).
- Suppression refusée (409) s'il existe des inscriptions validées.

*resource-service (à faire).*
- `POST /rooms` · `PUT /rooms/{id}` · `DELETE /rooms/{id}` : admin. Corps : `{name, building, capacity, equipment[], ...}` ; 403 · 409 `ROOM_EXISTS` · 422.
- Suppression refusée (409) s'il existe des réservations à venir.

*Front (à faire).* Un écran d'administration « Gérer les cours » dans le module Académique et « Gérer les salles » dans Ressources (formulaire de création, modification, suppression), visibles pour l'admin seulement. Les fonctions d'`api/` et leurs mocks correspondent aux routes ci-dessus.

*Chaque service.* Vérifier le rôle `admin` lui-même (403 sinon), conformément à la règle « chaque service relit le rôle ».

**Alternatives écartées.** Chargement des données directement en base (non reproductible, aucune gestion en production) ; création des cours par les enseignants avec validation par l'admin (statut « en attente » supplémentaire, hors périmètre de la v1).

**Statut :** à confirmer par l'encadrant et par les responsables des modules Académique et Ressources.
