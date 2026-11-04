import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Configuration typée et validée au démarrage : une variable mal formée fait échouer le processus tout de suite,
 * avec un message clair, plutôt que de produire un comportement étrange plus tard.
 * Les variables vides (`CLE=`) sont traitées comme absentes et reçoivent leur valeur par défaut.
 */
const DEFAULT_ADMIN_PASSWORD = "Admin2026!";
const num = (def: number) => z.coerce.number().int().nonnegative().default(def);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: num(4001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  MONGODB_URI: z.string().min(1).default("mongodb://localhost:27017/smartcampus_users"),
  JWT_SECRET: z.string().min(1).default("dev-secret-change-me"),
  JWT_EXPIRES_IN: z.string().min(1).default("2h"),
  // Cookies de session (mode « X-Auth-Mode: cookie »). Secure par défaut en production.
  COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  COOKIE_DOMAIN: z.string().min(1).optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Signature des jetons : RS256 (clé privée) en production ; HS256 (JWT_SECRET) en développement seulement.
  JWT_PRIVATE_KEY: z.string().min(1).optional(), // PEM (retours à la ligne en \\n) ou PEM encodé en base64
  JWT_PRIVATE_KEY_FILE: z.string().min(1).optional(), // chemin d'un fichier PEM (secret Docker, volume…)
  JWT_PREVIOUS_PUBLIC_KEY: z.string().min(1).optional(), // ancienne clé publique, le temps d'une rotation
  JWT_ISSUER: z.string().min(1).default("smartcampus-user-service"),
  JWT_AUDIENCE: z.string().min(1).default("smartcampus"),
  // Durcissement (voir docs/SECURITE.md)
  TRUST_PROXY: num(0), // nombre de proxys de confiance devant le service (0 = aucun : X-Forwarded-For est ignoré)
  ENABLE_DOCS: z.enum(["true", "false"]).optional(), // /docs et /openapi.json (défaut : hors production seulement)
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15), // durée du verrouillage après trop d'échecs
  CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5), // essais autorisés par code de vérification
  EMAIL_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60), // délai entre deux envois au même destinataire
  // Fenêtre de grâce du rafraîchissement : deux onglets qui présentent le même jeton à quelques secondes d'écart ne sont pas un vol.
  REFRESH_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
  LOGIN_HISTORY_RETENTION_DAYS: z.coerce.number().int().positive().default(180), // purge automatique de l'historique de connexion
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_DOMAIN: z.string().min(1).default("smartcampus.tn"),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(5),
  FIRST_ADMIN_EMAIL: z.string().min(1).default("admin@smartcampus.tn"),
  FIRST_ADMIN_PASSWORD: z.string().min(1).default(DEFAULT_ADMIN_PASSWORD),
  FIRST_ADMIN_FIRST_NAME: z.string().min(1).default("Admin"),
  FIRST_ADMIN_LAST_NAME: z.string().min(1).default("SmartCampus"),
  SMTP_HOST: z.string().min(1).default("localhost"),
  SMTP_PORT: num(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(1).default("SmartCampus <no-reply@smartcampus.tn>"),
  EXPOSE_TEMP_PASSWORD: z.string().optional(),
  RABBITMQ_URL: z.string().default(""),
  RABBITMQ_EXCHANGE: z.string().min(1).default("smartcampus.events"),
  METRICS_TOKEN: z.string().min(8).optional(),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).optional(),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).default(20),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).default(60_000),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
});

/** PEM brut, PEM avec « \\n » littéraux (variable d'environnement sur une ligne) ou PEM encodé en base64. */
function normalizePem(value: string): string {
  const v = value.trim();
  return v.includes("-----BEGIN") ? v.replace(/\\n/g, "\n") : Buffer.from(v, "base64").toString("utf8");
}

function load(source: NodeJS.ProcessEnv) {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n");
    throw new Error(`Configuration invalide :\n${problems}`);
  }
  const env = parsed.data;

  const config = {
    nodeEnv: env.NODE_ENV,
    isProd: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    frontendUrl: env.FRONTEND_URL,
    mongoUri: env.MONGODB_URI,
    jwtSecret: env.JWT_SECRET,
    jwt: {
      privateKey: env.JWT_PRIVATE_KEY_FILE
        ? readFileSync(env.JWT_PRIVATE_KEY_FILE, "utf8")
        : env.JWT_PRIVATE_KEY
          ? normalizePem(env.JWT_PRIVATE_KEY)
          : undefined,
      previousPublicKey: env.JWT_PREVIOUS_PUBLIC_KEY ? normalizePem(env.JWT_PREVIOUS_PUBLIC_KEY) : undefined,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    trustProxy: env.TRUST_PROXY,
    refreshGraceSeconds: env.REFRESH_GRACE_SECONDS,
    loginHistoryRetentionDays: env.LOGIN_HISTORY_RETENTION_DAYS,
    docsEnabled: env.ENABLE_DOCS ? env.ENABLE_DOCS === "true" : env.NODE_ENV !== "production",
    bcryptRounds: env.BCRYPT_ROUNDS,
    lockoutMinutes: env.LOCKOUT_MINUTES,
    codeMaxAttempts: env.CODE_MAX_ATTEMPTS,
    emailCooldownSeconds: env.EMAIL_COOLDOWN_SECONDS,
    cookies: {
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN,
      secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : env.NODE_ENV === "production",
    },
    emailDomain: env.EMAIL_DOMAIN.toLowerCase(),
    maxAttempts: env.MAX_LOGIN_ATTEMPTS,
    firstAdmin: {
      email: env.FIRST_ADMIN_EMAIL.toLowerCase(),
      password: env.FIRST_ADMIN_PASSWORD,
      firstName: env.FIRST_ADMIN_FIRST_NAME,
      lastName: env.FIRST_ADMIN_LAST_NAME,
    },
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
    },
    exposeTempPassword: env.EXPOSE_TEMP_PASSWORD === "true",
    rabbit: { url: env.RABBITMQ_URL, exchange: env.RABBITMQ_EXCHANGE },
    metricsToken: env.METRICS_TOKEN,
    // Délai entre « /ready passe à 503 » et la fermeture du serveur, pour que le répartiteur retire l'instance du trafic.
    shutdownDrainMs: env.SHUTDOWN_DRAIN_MS ?? (env.NODE_ENV === "production" ? 5000 : 0),
    mongo: { maxPoolSize: env.MONGO_MAX_POOL_SIZE, serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS },
    outbox: {
      pollMs: env.OUTBOX_POLL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseMs: env.OUTBOX_LEASE_MS,
      maxBackoffMs: env.OUTBOX_MAX_BACKOFF_MS,
      retentionMs: env.OUTBOX_RETENTION_DAYS * 86_400_000,
    },
  };

  if (config.isProd) {
    // En production, le service refuse de démarrer plutôt que de tourner avec une configuration d'exemple.
    const problems: string[] = [];
    // Un secret partagé (HS256) permettrait à n'importe quel service qui le connaît de forger un jeton administrateur.
    if (!config.jwt.privateKey) {
      problems.push("JWT_PRIVATE_KEY (ou JWT_PRIVATE_KEY_FILE) : clé RSA obligatoire en production (RS256). Générer : npm run keys:generate");
    }
    const adminPassword = config.firstAdmin.password;
    const weakAdmin = adminPassword.length < 12 || !/[A-Z]/.test(adminPassword) || !/[a-z]/.test(adminPassword) || !/\d/.test(adminPassword);
    if (adminPassword === DEFAULT_ADMIN_PASSWORD || weakAdmin) {
      problems.push("FIRST_ADMIN_PASSWORD : à définir, 12 caractères minimum (majuscule, minuscule, chiffre), différent de la valeur par défaut");
    }
    if (config.exposeTempPassword) problems.push("EXPOSE_TEMP_PASSWORD ne doit jamais être activé en production");
    if (!config.cookies.secure) problems.push("COOKIE_SECURE ne doit pas être désactivé en production");
    if (problems.length) throw new Error(`Configuration de production refusée :\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  if (config.cookies.sameSite === "none" && !config.cookies.secure) {
    throw new Error("COOKIE_SAMESITE=none exige des cookies Secure (COOKIE_SECURE=true)");
  }
  return config;
}

export const config = load(process.env);
export type Config = typeof config;
