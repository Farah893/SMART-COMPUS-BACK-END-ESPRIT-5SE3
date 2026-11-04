# Politique de sécurité

## Signaler une vulnérabilité
**Ne l'ouvre pas dans une issue publique.** Utilise le signalement privé de GitHub :
onglet **Security** du dépôt → **Report a vulnerability** (« Private vulnerability reporting »).

Indique : ce que tu as trouvé, comment le reproduire (requêtes, étapes), l'impact que tu imagines, et la version (commit).
Réponse visée : accusé de réception sous 7 jours, correctif ou plan sous 30 jours selon la gravité.

## Périmètre
- Le service d'utilisateurs / l'interface SmartCampus de ce dépôt : authentification, sessions, autorisations, validation des entrées,
  configuration de production.
- Hors périmètre : déni de service par volume brut, ingénierie sociale, failles dans des services tiers.

## Version prise en charge
Seule la dernière version de la branche par défaut reçoit des correctifs de sécurité.

## Ce qui est déjà en place
Voir `docs/SECURITE.md` (mesures, audit, risques résiduels) et `docs/SAST-ET-IMAGE-DOCKER.md` (analyse statique et image Docker) dans le dépôt backend.
