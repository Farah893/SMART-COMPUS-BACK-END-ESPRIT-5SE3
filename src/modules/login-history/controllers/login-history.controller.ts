import type { Request, Response } from "express";
import { dtoOf } from "../../../shared/middleware/validate.js";
import { toLoginEventResponse, type LoginHistoryQueryDto } from "../dto/login-history.dto.js";
import type { LoginHistoryService } from "../services/login-history.service.js";

export class LoginHistoryController {
  constructor(private readonly history: LoginHistoryService) {}

  /** GET /login-history (admin) — tous les comptes. */
  all = async (req: Request, res: Response) => {
    const events = await this.history.listAll(dtoOf<LoginHistoryQueryDto>(req).result);
    res.json(events.map(toLoginEventResponse));
  };

  /** GET /users/:id/login-history — soi-même ou admin. */
  forUser = async (req: Request, res: Response) => {
    const events = await this.history.listForUser(req.params.id!, dtoOf<LoginHistoryQueryDto>(req).result);
    res.json(events.map(toLoginEventResponse));
  };
}
