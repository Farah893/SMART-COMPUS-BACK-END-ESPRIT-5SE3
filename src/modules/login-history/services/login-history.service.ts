import { fullName } from "../../../shared/utils/full-name.js";
import type { RequestContext } from "../../../shared/utils/request-context.js";
import { loginAttempts } from "../../../infrastructure/observability/metrics.js";
import { describeDevice } from "../../../shared/utils/user-agent.js";
import type { User } from "../../users/types/user.types.js";
import type { LoginHistoryRepository, LoginResultFilter } from "../repositories/login-history.repository.js";

export class LoginHistoryService {
  constructor(private readonly events: LoginHistoryRepository) {}

  /** Enregistre une tentative de connexion (réussie ou non). */
  record = (user: User, context: RequestContext, success: boolean) => {
    loginAttempts.inc({ result: success ? "success" : "failure" });
    return this.events.create({
      userId: user._id, userName: fullName(user), success, ip: context.ip, device: describeDevice(context.userAgent),
    });
  };

  listAll = (result: LoginResultFilter) => this.events.findAll(result);
  listForUser = (userId: string, result: LoginResultFilter) => this.events.findByUser(userId, result);
}
