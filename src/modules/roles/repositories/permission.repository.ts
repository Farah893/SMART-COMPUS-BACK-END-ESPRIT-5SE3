import type { Role } from "../../../shared/constants/index.js";
import { Permission, type PermissionEntity } from "../models/permission.model.js";

export interface PermissionRepository {
  findAll(): Promise<PermissionEntity[]>;
  setGranted(role: Role, key: string, granted: boolean): Promise<void>;
  insertMissing(defaults: PermissionEntity[]): Promise<void>;
}

export class MongoPermissionRepository implements PermissionRepository {
  findAll = () => Permission.find().lean().exec();

  setGranted: PermissionRepository["setGranted"] = async (role, key, granted) => {
    await Permission.updateOne({ role, key }, { granted }, { upsert: true });
  };

  /** `$setOnInsert` : au redémarrage, les modifications faites par l'administrateur ne sont pas écrasées. */
  insertMissing: PermissionRepository["insertMissing"] = async (defaults) => {
    await Permission.bulkWrite(
      defaults.map(({ role, key, granted }) => ({
        updateOne: { filter: { role, key }, update: { $setOnInsert: { granted } }, upsert: true },
      })),
    );
  };
}
