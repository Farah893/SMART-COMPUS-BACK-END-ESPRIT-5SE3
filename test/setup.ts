// Chargé avant tout import de test (node --import) : la config lit NODE_ENV une seule fois, au premier import.
process.env.NODE_ENV ??= "test";
process.env.BCRYPT_ROUNDS ??= "4"; // bcrypt coûteux en production (12), rapide en test
process.env.REFRESH_GRACE_SECONDS ??= "0"; // les tests de rejeu attendent une révocation immédiate (la fenêtre de grâce est testée à part)
process.env.EMAIL_DOMAIN ??= "gmail.com"; // domaine d'adresse accepté (identique à celui des tests et du .env.example)
process.env.FIRST_ADMIN_EMAIL ??= "admin@gmail.com";
