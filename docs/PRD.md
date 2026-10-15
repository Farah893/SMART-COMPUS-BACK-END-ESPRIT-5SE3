# PRD — Module Utilisateurs (user-service + front)

Document de besoins produit du module 1 de SmartCampus. Il couvre le back-end (`user-service`) et le front-end (`src/features/users`).

## 1. Contexte et objectif

SmartCampus est une plateforme de campus (cours, notes, salles, résidences, clubs, bibliothèque) pour **étudiants**, **enseignants** et **administrateurs**.
Le module Utilisateurs est le socle : il **identifie** qui est connecté (authentification), **décrit** ce qu'il peut faire (rôle, permissions) et **trace** ses connexions. Les 5 autres modules dépendent de son JWT.

**Objectifs**
1. Permettre à toute personne du campus de se connecter de façon sûre.
2. Permettre à un administrateur de créer et gérer les comptes sans jamais connaître le mot de passe final de l'utilisateur.
3. Fournir aux autres services un jeton signé contenant l'identité et le rôle.
4. Garder une trace des connexions (succès et échecs) pour l'audit.

**Hors périmètre (v1)** : double authentification, SSO/OAuth, refresh token, import CSV de comptes, upload de fichiers (la photo est une image 256 px encodée), journal d'audit des actions admin.

## 2. Utilisateurs et rôles

| Rôle | Comment il obtient son compte | Peut faire |
|---|---|---|
| `student` | Auto-inscription publique, ou création par un admin | Se connecter, gérer son profil, sa photo, son mot de passe, voir ses connexions |
| `teacher` | Créé par un admin uniquement | Idem étudiant |
| `admin` | Premier admin créé au démarrage du service ; les autres par un admin | Tout ce qui précède + gérer tous les comptes, rôles, permissions, historique global |

Les droits fins (ex. `academic.grades`) sont des **permissions** rattachées au rôle (matrice rôle × permission), modifiables par l'admin.

## 3. Exigences fonctionnelles

| ID | Exigence | Back | Front |
|---|---|---|---|
| F1 | Connexion e-mail + mot de passe, renvoie un JWT et le profil | `POST /auth/login` | `/connexion` |
| F2 | Inscription publique : **toujours étudiant**, e-mail du domaine institutionnel, mot de passe fort | `POST /auth/register` | `/inscription` |
| F3 | Vérification d'e-mail par code à 6 chiffres (15 min) et renvoi du code | `/auth/verify-email`, `/auth/resend-activation` | `/verification-email` |
| F4 | Mot de passe oublié : lien à usage unique valable 1 h ; la réponse ne révèle jamais si le compte existe | `/auth/forgot-password`, `/auth/reset-password` | `/mot-de-passe-oublie`, `/reinitialiser-mot-de-passe` |
| F5 | L'admin crée un compte (enseignant, étudiant, admin) : mot de passe temporaire généré et envoyé par e-mail ; `mustChangePassword = true` | `POST /users` | Utilisateurs → *Créer un compte* |
| F6 | À la première connexion avec un mot de passe temporaire, l'utilisateur doit choisir un nouveau mot de passe, différent du temporaire | `PUT /users/:id/password` | `/changer-mot-de-passe` |
| F7 | L'admin liste, recherche (nom, e-mail, matricule) et filtre (rôle, statut) les comptes ; statistiques globales | `GET /users` | Onglet *Comptes* |
| F8 | Profil : voir/modifier prénom, nom, téléphone ; photo ; changer le mot de passe | `GET/PUT /users/:id`, `PUT /users/:id/avatar`, `PUT /users/:id/password` | `/profil` |
| F9 | L'admin change le rôle, active/désactive, supprime un compte | `PUT /users/:id/role`, `PATCH /users/:id/status`, `DELETE /users/:id` | Onglet *Comptes* |
| F10 | Matrice rôles × permissions consultable et modifiable | `GET/PUT /roles/permissions` | Onglet *Rôles et permissions* |
| F11 | Historique de connexion (par utilisateur, ou global pour l'admin), filtrable succès/échec | `GET /users/:id/login-history`, `GET /login-history` | Onglet *Historique*, `/profil` |
| F12 | Événements de domaine `UtilisateurCréé` et `RôleModifié` publiés | RabbitMQ | — |

## 4. Règles métier

- **R1** Une adresse e-mail = un compte (409 `EMAIL_EXISTS`). Le domaine doit être `EMAIL_DOMAIN` (422).
- **R2** Mot de passe : 8 caractères minimum, une majuscule, une minuscule, un chiffre.
- **R3** 5 échecs de connexion consécutifs **suspendent** le compte (423 `ACCOUNT_LOCKED`). Seul un admin le réactive (le compteur repart à 0).
- **R4** Un compte `inactive` ne peut pas se connecter (403 `ACCOUNT_INACTIVE`).
- **R5** Le rôle vient toujours du compte en base, jamais d'un formulaire. Il est placé dans le JWT, mais le service **relit le compte à chaque requête** : un rôle retiré ou un compte désactivé prend effet immédiatement.
- **R6** Un admin ne peut ni supprimer, ni désactiver, ni changer le rôle de **son propre** compte (409 `SELF_PROTECTED`).
- **R7** Les droits `users.*` de l'admin sont verrouillés dans la matrice (403).
- **R8** Le nouveau mot de passe doit différer de l'actuel (422 `SAME_PASSWORD`) et être fort (422 `WEAK_PASSWORD`).

## 5. Exigences non fonctionnelles

| Domaine | Exigence | État |
|---|---|---|
| Sécurité | Mots de passe hachés (bcrypt), jamais renvoyés ; jetons de vérification/réinitialisation stockés hachés (SHA-256) et à expiration automatique | Fait |
| Sécurité | JWT signé HS256, expiration `JWT_EXPIRES_IN` (2 h) ; en-têtes `helmet` ; CORS restreint ; limite 100 req / 15 min sur `/auth` | Fait |
| Sécurité | Validation de toutes les entrées (zod) ; pas d'injection NoSQL (champs typés, regex échappées) | Fait |
| Disponibilité | `GET /health` (503 si MongoDB est injoignable) ; arrêt propre sur SIGTERM | Fait |
| Observabilité | Journal HTTP (morgan) et journal des événements | Partiel (pas de métriques ni de traces) |
| Qualité | Tests d'intégration sur les parcours critiques | 5 tests, parcours principaux |
| Évolutivité | Service sans état (JWT) : plusieurs instances possibles derrière la Gateway | Oui, sauf seed concurrent au 1er démarrage (sans gravité : e-mail unique) |

## 6. Contrat d'erreur

Toute erreur renvoie `{ "message": "...", "code": "...", ...détails }`.

| Statut | Quand | Codes |
|---|---|---|
| 400 | Code/lien invalide | `INVALID_CODE`, `INVALID_TOKEN` |
| 401 | Identifiants ou jeton invalides | `INVALID_CREDENTIALS` (+ `failedAttempts`, `max`), `WRONG_PASSWORD`, `INVALID_TOKEN` |
| 403 | Droit insuffisant, compte désactivé | `ACCOUNT_INACTIVE` |
| 404 | Compte inconnu | — |
| 409 | E-mail existant, auto-protection admin | `EMAIL_EXISTS`, `SELF_PROTECTED` |
| 422 | Validation | `VALIDATION_ERROR`, `INVALID_DOMAIN`, `WEAK_PASSWORD`, `SAME_PASSWORD` |
| 423 | Compte suspendu | `ACCOUNT_LOCKED` (+ `failedAttempts`, `max`) |

## 7. Critères d'acceptation (extraits, couverts par `test/api.test.js`)

1. L'admin crée `karim@…` (enseignant) → 201, `mustChangePassword = true`, aucun hash dans la réponse ; recréer la même adresse → 409.
2. Karim se connecte avec le temporaire → `mustChangePassword = true` ; changer vers le même mot de passe → `SAME_PASSWORD` ; vers `abc` → `WEAK_PASSWORD` ; avec un mauvais actuel → 401 ; valide → 200 et le drapeau disparaît.
3. Karim ne peut ni lister les comptes (403) ni lire le compte d'un autre (403) ; sans jeton → 401.
4. L'inscription avec `role: "admin"` crée un `student` ; domaine `@gmail.com` → 422 ; doublon → 409.
5. 5 mauvais mots de passe → 423 ; même avec le bon → 423 ; l'admin réactive → connexion 200 ; l'historique contient 6 échecs.
6. L'admin ne peut pas changer son propre rôle ni se supprimer (409) ; modifier `users.manage` de l'admin → 403.

## 8. Dépendances et risques

| Sujet | Risque | Mitigation |
|---|---|---|
| Autres services | Doivent vérifier le JWT avec le même `JWT_SECRET` | Documenter ; à terme, passer en RS256 (clé publique) |
| Jeton volé | Valable jusqu'à expiration (2 h) | Le rôle/statut sont relus en base ; refresh token + révocation à prévoir |
| 401 côté front | Le front ne déconnecte pas automatiquement sur jeton expiré | Intercepteur `onError` à ajouter |
| Perte d'événement | Pas d'outbox : si RabbitMQ tombe, l'événement n'est que journalisé | Pattern outbox à prévoir |
| Photo | Data URL dans MongoDB (≤ ~500 Ko) | Stockage objet (S3/MinIO) en production |

## 9. Évolutions (backlog)

Refresh token et révocation · journal d'audit des actions admin · 2FA · import CSV · stockage objet pour les photos · outbox pour les événements · RS256 · métriques Prometheus · pagination de `GET /users` (limite actuelle : 500).
