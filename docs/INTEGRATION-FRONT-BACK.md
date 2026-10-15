# Liaison front ↔ back (module Utilisateurs)

## 1. Principe

Le front a été conçu **contract-first** : chaque fonction de `src/features/users/api/index.ts` correspond à une route du microservice et fournit un `mock` pour fonctionner seul. Brancher le back = désactiver les mocks. Aucune page n'a été réécrite.

```
Page React ─► hook (useUsers…) ─► fonction api/ ─► src/api/client.ts ─► fetch(API_BASE_URL + route)
                                                        │ intercepteur : ajoute  Authorization: Bearer <JWT>
                                                        └ erreur HTTP → ApiError(status, message, details = corps JSON)
```

## 2. Configuration

Fichier `.env` du **front** (non versionné) :

```
VITE_USE_MOCKS=false                    # false = vrai back-end
VITE_API_BASE_URL=http://localhost:4001 # le user-service (ou la Gateway : http://localhost:8080/api)
VITE_EMAIL_DOMAIN=smartcampus.tn        # DOIT être identique à EMAIL_DOMAIN du back
```

Fichier `.env` du **back** : `CORS_ORIGINS=http://localhost:5173` (le navigateur bloque sinon), `EXPOSE_TEMP_PASSWORD=true` en développement, `JWT_SECRET`, `MONGODB_URI`.
Après modification, relancer `npm run dev` des deux côtés.

## 3. Comment les données circulent

### Connexion
1. `LoginPage` appelle `login(email, password)` → `POST /auth/login`.
2. Le back répond `{ token, user }`. Le front fait `openSession(user, token)` : le JWT va dans `localStorage` (`tokenStore`), le profil dans la session.
3. À chaque appel suivant, l'intercepteur ajoute `Authorization: Bearer <token>`. Le back vérifie la signature, relit le compte et en déduit le rôle.
4. Si `user.mustChangePassword` est vrai, le front redirige vers `/changer-mot-de-passe`.

### Erreurs : le contrat qui fait fonctionner l'UI
Le client met le **corps JSON de l'erreur dans `ApiError.details`**. Le front lit directement :

| Réponse du back | Effet à l'écran |
|---|---|
| 401 + `failedAttempts`, `max` | « Identifiants invalides — il reste N essais » |
| 423 `ACCOUNT_LOCKED` | Bannière « compte suspendu » et champ mot de passe bloqué |
| 403 | « Compte désactivé » |
| 409 `EMAIL_EXISTS` | Erreur sur le champ e-mail |
| 401 `WRONG_PASSWORD`, 422 `SAME_PASSWORD` | Erreur sur le bon champ du formulaire de mot de passe |
| 422 `WEAK_PASSWORD` | Pas de message dédié : le front valide la force du mot de passe avant l'envoi, le back reste la garde de sécurité |
| 0 / 502 / 503 / 504 | Écran « service indisponible » |

C'est pourquoi le back renvoie toujours `{ message, code, … }`.

### Forme des données
`UserAccount` (TypeScript) = JSON renvoyé par `User.toJSON()` : `id` (matricule), `firstName`, `lastName`, `email`, `role`, `status`, `failedAttempts`, `createdAt`, `lastLoginAt`, et optionnellement `phone`, `avatarUrl`, `mustChangePassword`. Les dates sont en ISO 8601.

## 4. Modifications faites dans le front pour le brancher

| Fichier | Problème trouvé | Correction |
|---|---|---|
| `features/users/auth/AuthContext.tsx` | Un `useEffect` **écrasait le vrai JWT par un faux** (`fakeJwt`) à chaque changement de session : le back aurait répondu 401 partout | Le faux jeton n'est écrit qu'en mode mock (`USE_MOCKS`) |
| `features/users/api/index.ts` | `listUsers` et `getLoginHistory` n'envoyaient ni `q`, `role`, `status`, ni `result` : le filtrage n'existait que dans les mocks | Ajout d'un helper `query()` qui construit `?q=…&role=…` (valeurs vides ignorées) |
| `features/users/auth/pages/LoginPage.tsx` | Le bloc « Mode démo » (connexion sans mot de passe) restait affiché avec le vrai back | Affiché seulement si `USE_MOCKS` |

## 5. Vérifications effectuées

Contre une vraie MongoDB (Docker) et le service lancé :
- `GET /health` → `UP` ; premier admin créé ; préflight CORS depuis `http://localhost:5173` accepté (204).
- Connexion admin, création d'un enseignant (matricule `ENS-2026-0001`), e-mail reçu dans Mailpit.
- `GET /users?role=teacher&q=karim` filtre côté serveur ; `GET /login-history?result=success` fonctionne ; sans jeton → 401.
- `npm run typecheck` du front passe.
- 5 tests d'intégration du back passent.

**Non vérifié** : parcours complet dans le navigateur (clics sur les écrans), RabbitMQ, API Gateway.

## 6. Procédure de test dans le navigateur

1. `docker compose up -d mongo mailpit` puis `npm run dev` (back) ; `npm run dev` (front).
2. Ouvrir `http://localhost:5173`, *Se connecter* avec `admin@smartcampus.tn` / `Admin2026!`.
3. *Utilisateurs → Créer un compte* : un mot de passe temporaire s'affiche (et l'e-mail est visible sur `http://localhost:8025`).
4. Se déconnecter, se connecter avec le nouveau compte : le changement de mot de passe est imposé.
5. 5 mauvais mots de passe sur un compte : 423, puis réactivation par l'admin.

## 7. Reste à faire côté front

- **Déconnexion automatique sur 401** : enregistrer un `onError` (déjà prévu dans `client.ts`) qui appelle `logout()` quand le jeton expire ou que le compte est désactivé.
- **Rôle dans l'interface** : `user.role` vient de la session locale ; le back reste la seule autorité (403 si interdit).
- **Autres modules** : tant que leurs services n'existent pas, laisser leurs mocks. `VITE_USE_MOCKS` est global : en `false`, les 5 autres modules appelleront la Gateway et échoueront (503) — prévoir un drapeau par module si besoin.
