import mongoose, { Schema } from "mongoose";
import { ROLES, type Role } from "../../../shared/constants/index.js";

export interface PermissionEntity {
  role: Role;
  key: string;
  granted: boolean;
}

const permissionSchema = new Schema<PermissionEntity>({
  role: { type: String, enum: ROLES, required: true },
  key: { type: String, required: true },
  granted: { type: Boolean, default: false },
});
permissionSchema.index({ role: 1, key: 1 }, { unique: true });

export const Permission = mongoose.model<PermissionEntity>("Permission", permissionSchema);
