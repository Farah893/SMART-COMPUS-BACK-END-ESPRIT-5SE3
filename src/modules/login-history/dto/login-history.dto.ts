import { z } from "zod";
import type { LoginEventRecord } from "../models/login-event.model.js";

/** ?result=success|failure — toute autre valeur est ignorée. */
export const loginHistoryQueryDto = z.object({ result: z.enum(["success", "failure"]).optional().catch(undefined) });
export type LoginHistoryQueryDto = z.infer<typeof loginHistoryQueryDto>;

export interface LoginEventResponse {
  id: string;
  userId: string;
  userName?: string;
  date: string;
  ip?: string;
  device?: string;
  success?: boolean;
}

export const toLoginEventResponse = (e: LoginEventRecord): LoginEventResponse => ({
  id: String(e._id),
  userId: e.userId,
  userName: e.userName,
  date: new Date(e.date).toISOString(),
  ip: e.ip,
  device: e.device,
  success: e.success,
});
