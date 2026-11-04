import type { Request, Response } from "express";
import { AppError, unauthorized } from "../../../shared/errors/app-error.js";
import {
  assertCsrfSafe, clearAuthCookies, hasAuthCookie, isCookieMode, readCookie, REFRESH_COOKIE, setAuthCookies,
} from "../../../shared/http/auth-cookies.js";
import { dtoOf } from "../../../shared/middleware/validate.js";
import { currentUser, requestContext } from "../../../shared/utils/request-context.js";
import { toUserResponse } from "../../users/dto/user.dto.js";
import {
  OK_RESPONSE, toLoginResponse, toSessionResponse,
  type EmailDto, type LoginDto, type RefreshBody, type RegisterDto, type ResetPasswordDto, type VerifyEmailDto,
} from "../dto/auth.dto.js";
import type { AuthService } from "../services/auth.service.js";

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Mode cookie : jetons en cookies httpOnly, corps sans jeton. Sinon : comportement historique. */
  private respondWithSession(req: Request, res: Response, session: Parameters<typeof toLoginResponse>[0]) {
    if (!isCookieMode(req)) return res.json(toLoginResponse(session));
    setAuthCookies(res, session);
    return res.json(toSessionResponse(session));
  }

  /**
   * Jeton de rafraîchissement : corps d'abord (clients historiques), sinon cookie.
   * Le contrôle CSRF s'applique dès que NOS cookies sont joints à la requête, quelle que soit la provenance du jeton :
   * un appelant ne peut donc pas s'y soustraire en ajoutant un jeton dans le corps (condition qu'il contrôlerait).
   */
  private refreshTokenOf(req: Request): string | undefined {
    if (hasAuthCookie(req)) assertCsrfSafe(req);
    return dtoOf<RefreshBody>(req).refreshToken ?? readCookie(req, REFRESH_COOKIE);
  }

  login = async (req: Request, res: Response) => {
    this.respondWithSession(req, res, await this.auth.login(dtoOf<LoginDto>(req), requestContext(req)));
  };

  refresh = async (req: Request, res: Response) => {
    const refreshToken = this.refreshTokenOf(req);
    if (!refreshToken) throw unauthorized("Session invalide ou expirée", { code: "INVALID_REFRESH_TOKEN" });
    try {
      this.respondWithSession(req, res, await this.auth.refresh({ refreshToken }));
    } catch (e) {
      // Session morte : on retire aussi les cookies, sinon le navigateur les renverrait indéfiniment.
      if (e instanceof AppError && isCookieMode(req)) clearAuthCookies(res);
      throw e;
    }
  };

  logout = async (req: Request, res: Response) => {
    const refreshToken = this.refreshTokenOf(req);
    if (refreshToken) await this.auth.logout({ refreshToken });
    clearAuthCookies(res);
    res.json(OK_RESPONSE);
  };

  logoutAll = async (req: Request, res: Response) => {
    await this.auth.logoutAll(currentUser(req));
    clearAuthCookies(res);
    res.json(OK_RESPONSE);
  };

  register = async (req: Request, res: Response) => {
    res.status(201).json(toUserResponse(await this.auth.register(dtoOf<RegisterDto>(req))));
  };

  verifyEmail = async (req: Request, res: Response) => {
    await this.auth.verifyEmail(dtoOf<VerifyEmailDto>(req));
    res.json(OK_RESPONSE);
  };

  resendActivation = async (req: Request, res: Response) => {
    await this.auth.resendActivation(dtoOf<EmailDto>(req));
    res.json(OK_RESPONSE);
  };

  forgotPassword = async (req: Request, res: Response) => {
    await this.auth.forgotPassword(dtoOf<EmailDto>(req));
    res.json(OK_RESPONSE);
  };

  resetPassword = async (req: Request, res: Response) => {
    await this.auth.resetPassword(dtoOf<ResetPasswordDto>(req));
    res.json(OK_RESPONSE);
  };
}
