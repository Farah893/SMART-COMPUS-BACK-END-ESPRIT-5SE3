import { LoginEvent, type LoginEventRecord, type LoginEventEntity } from "../models/login-event.model.js";

export type LoginResultFilter = "success" | "failure" | undefined;

export interface LoginHistoryRepository {
  create(data: Omit<LoginEventEntity, "date">): Promise<void>;
  findAll(result: LoginResultFilter, limit?: number): Promise<LoginEventRecord[]>;
  findByUser(userId: string, result: LoginResultFilter, limit?: number): Promise<LoginEventRecord[]>;
}

const resultFilter = (result: LoginResultFilter) =>
  result === "success" ? { success: true } : result === "failure" ? { success: false } : {};

export class MongoLoginHistoryRepository implements LoginHistoryRepository {
  constructor(private readonly retentionDays = 180) {}

  create = async (data: Omit<LoginEventEntity, "date">) => {
    await LoginEvent.create({ ...data, expiresAt: new Date(Date.now() + this.retentionDays * 86_400_000) });
  };
  findAll = (result: LoginResultFilter, limit = 500) => LoginEvent.find(resultFilter(result)).sort({ date: -1 }).limit(limit).lean<LoginEventRecord[]>().exec();
  findByUser = (userId: string, result: LoginResultFilter, limit = 200) =>
    LoginEvent.find({ userId, ...resultFilter(result) }).sort({ date: -1 }).limit(limit).lean<LoginEventRecord[]>().exec();
}
