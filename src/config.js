const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4001),
  isProd: env.NODE_ENV === "production",
  corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  frontendUrl: env.FRONTEND_URL ?? "http://localhost:5173",
  mongoUri: env.MONGODB_URI ?? "mongodb://localhost:27017/smartcampus_users",
  jwtSecret: env.JWT_SECRET ?? "dev-secret-change-me",
  jwtExpiresIn: env.JWT_EXPIRES_IN ?? "2h",
  emailDomain: (env.EMAIL_DOMAIN ?? "smartcampus.tn").toLowerCase(),
  maxAttempts: Number(env.MAX_LOGIN_ATTEMPTS ?? 5),
  firstAdmin: {
    email: (env.FIRST_ADMIN_EMAIL ?? "admin@smartcampus.tn").toLowerCase(),
    password: env.FIRST_ADMIN_PASSWORD ?? "Admin2026!",
    firstName: env.FIRST_ADMIN_FIRST_NAME ?? "Admin",
    lastName: env.FIRST_ADMIN_LAST_NAME ?? "SmartCampus",
  },
  smtp: {
    host: env.SMTP_HOST ?? "localhost",
    port: Number(env.SMTP_PORT ?? 1025),
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.MAIL_FROM ?? "SmartCampus <no-reply@smartcampus.tn>",
  },
  exposeTempPassword: env.EXPOSE_TEMP_PASSWORD === "true",
  rabbit: { url: env.RABBITMQ_URL || "", exchange: env.RABBITMQ_EXCHANGE ?? "smartcampus.events" },
};

if (config.isProd && config.jwtSecret.startsWith("dev-secret")) {
  throw new Error("JWT_SECRET doit être défini en production");
}
