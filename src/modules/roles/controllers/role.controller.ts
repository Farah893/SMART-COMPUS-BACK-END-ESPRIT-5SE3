import type { Request, Response } from "express";
import { dtoOf } from "../../../shared/middleware/validate.js";
import { toPermissionMatrixResponse, type SetPermissionDto } from "../dto/role.dto.js";
import type { RoleService } from "../services/role.service.js";

export class RoleController {
  constructor(private readonly roles: RoleService) {}

  getPermissions = async (_req: Request, res: Response) => {
    res.json(toPermissionMatrixResponse(await this.roles.getMatrix()));
  };

  setPermission = async (req: Request, res: Response) => {
    await this.roles.setPermission(dtoOf<SetPermissionDto>(req));
    res.status(204).end();
  };
}
