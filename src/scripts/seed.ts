import { seed } from "../bootstrap/seed.js";
import { config } from "../config/index.js";
import { buildContainer } from "../container.js";
import { connectDatabase, disconnectDatabase } from "../infrastructure/database/mongo.js";

/** Usage : npm run seed */
await connectDatabase(config.mongoUri);
await seed(buildContainer());
await disconnectDatabase();
