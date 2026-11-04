import type { Request, Response } from "express";
import { dtoOf } from "../../../shared/middleware/validate.js";
import { currentUser } from "../../../shared/utils/request-context.js";
import {
  toAdminCreatedResponse, toUserListResponse, toUserResponse,
  type AdminCreateUserDto, type ChangePasswordDto, type ChangeRoleDto, type ChangeStatusDto,
  type ListUsersQueryDto, type UpdateAvatarDto, type UpdateProfileDto,
} from "../dto/user.dto.js";
import type { UserService } from "../services/user.service.js";

/** Couche HTTP : traduit la requête en appel de service et le résultat en DTO de sortie. Aucune règle métier ici. */
export class UserController {
  constructor(private readonly users: UserService) {}

  create = async (req: Request, res: Response) => {
    const result = await this.users.createByAdmin(dtoOf<AdminCreateUserDto>(req), currentUser(req));
    res.status(201).json(toAdminCreatedResponse(result));
  };

  list = async (req: Request, res: Response) => {
    res.json(toUserListResponse(await this.users.list(dtoOf<ListUsersQueryDto>(req))));
  };

  get = async (req: Request, res: Response) => {
    res.json(toUserResponse(await this.users.getById(req.params.id!)));
  };

  updateProfile = async (req: Request, res: Response) => {
    res.json(toUserResponse(await this.users.updateProfile(req.params.id!, dtoOf<UpdateProfileDto>(req))));
  };

  changePassword = async (req: Request, res: Response) => {
    await this.users.changePassword(req.params.id!, dtoOf<ChangePasswordDto>(req));
    res.json({ ok: true });
  };

  updateAvatar = async (req: Request, res: Response) => {
    res.json(toUserResponse(await this.users.updateAvatar(req.params.id!, dtoOf<UpdateAvatarDto>(req).avatarUrl)));
  };

  changeRole = async (req: Request, res: Response) => {
    res.json(toUserResponse(await this.users.changeRole(req.params.id!, dtoOf<ChangeRoleDto>(req).role, currentUser(req))));
  };

  changeStatus = async (req: Request, res: Response) => {
    res.json(toUserResponse(await this.users.changeStatus(req.params.id!, dtoOf<ChangeStatusDto>(req).status, currentUser(req))));
  };

  remove = async (req: Request, res: Response) => {
    await this.users.remove(req.params.id!, currentUser(req));
    res.status(204).end();
  };
}
