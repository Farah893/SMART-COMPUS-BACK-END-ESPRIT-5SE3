import { config } from "./config/index.js";
import { SmtpMailer } from "./infrastructure/mail/mailer.js";
import { RabbitEventBus } from "./infrastructure/messaging/event-bus.js";
import { OutboxEventPublisher } from "./infrastructure/messaging/outbox-publisher.js";
import { OutboxRelay } from "./infrastructure/messaging/outbox-relay.js";
import { registerOutboxGauge } from "./infrastructure/observability/metrics.js";
import type { Lifecycle } from "./modules/health/routes/health.routes.js";
import { MongoOutboxRepository } from "./infrastructure/messaging/outbox.repository.js";
import { bcryptPasswordHasher } from "./infrastructure/security/password-hasher.js";
import { jwtTokenService } from "./infrastructure/security/token-service.js";
import { AuthController } from "./modules/auth/controllers/auth.controller.js";
import { createAuthMiddleware } from "./modules/auth/middleware/auth.middleware.js";
import { AuthService } from "./modules/auth/services/auth.service.js";
import { MongoRefreshTokenRepository } from "./modules/auth/repositories/refresh-token.repository.js";
import { SessionService } from "./modules/auth/services/session.service.js";
import { MongoVerificationTokenRepository } from "./modules/auth/repositories/verification-token.repository.js";
import { LoginHistoryController } from "./modules/login-history/controllers/login-history.controller.js";
import { MongoLoginHistoryRepository } from "./modules/login-history/repositories/login-history.repository.js";
import { LoginHistoryService } from "./modules/login-history/services/login-history.service.js";
import { MongoPermissionRepository } from "./modules/roles/repositories/permission.repository.js";
import { RoleController } from "./modules/roles/controllers/role.controller.js";
import { RoleService } from "./modules/roles/services/role.service.js";
import { UserController } from "./modules/users/controllers/user.controller.js";
import { MongoUserRepository } from "./modules/users/repositories/user.repository.js";
import { UserService } from "./modules/users/services/user.service.js";

/**
 * Racine de composition : le SEUL endroit qui connaît les implémentations concrètes et câble les couches
 * (repository → service → controller). Les tests ou un autre point d'entrée peuvent substituer n'importe quel maillon.
 */
export function buildContainer() {
  // Infrastructure (adaptateurs des ports)
  const eventBus = new RabbitEventBus(config.rabbit); // transport RabbitMQ (connexion, confirmations)
  const outboxRepository = new MongoOutboxRepository();
  // Les services publient dans la boîte d'envoi ; le relais l'achemine vers le bus (voir server.ts).
  const eventPublisher = new OutboxEventPublisher(outboxRepository, { enabled: Boolean(config.rabbit.url) });
  registerOutboxGauge(() => outboxRepository.countPending());
  const lifecycle: Lifecycle = { draining: false };
  const outboxRelay = new OutboxRelay(outboxRepository, eventBus, config.outbox);
  const mailer = new SmtpMailer(config.smtp);
  const passwordHasher = bcryptPasswordHasher;
  const tokenService = jwtTokenService;

  // Repositories
  const userRepository = new MongoUserRepository();
  const tokenRepository = new MongoVerificationTokenRepository();
  const refreshTokenRepository = new MongoRefreshTokenRepository();
  const loginHistoryRepository = new MongoLoginHistoryRepository(config.loginHistoryRetentionDays);
  const permissionRepository = new MongoPermissionRepository();

  // Services
  const sessionService = new SessionService(refreshTokenRepository, { ttlDays: config.refreshTtlDays, graceSeconds: config.refreshGraceSeconds });
  const userService = new UserService({ userRepository, passwordHasher, mailer, eventBus: eventPublisher, sessionStore: sessionService, config });
  const loginHistoryService = new LoginHistoryService(loginHistoryRepository);
  const roleService = new RoleService(permissionRepository);
  const authService = new AuthService({
    userRepository, userService, tokenRepository, sessionService, loginHistoryService, passwordHasher, tokenService, mailer, eventBus: eventPublisher, config,
  });

  return {
    config,
    eventBus,
    lifecycle,
    tokenService,
    outboxRelay,
    outboxRepository,
    passwordHasher,
    userRepository,
    userService,
    roleService,
    auth: createAuthMiddleware({ userRepository, tokenService }),
    authController: new AuthController(authService),
    userController: new UserController(userService),
    roleController: new RoleController(roleService),
    loginHistoryController: new LoginHistoryController(loginHistoryService),
  };
}

export type Container = ReturnType<typeof buildContainer>;
