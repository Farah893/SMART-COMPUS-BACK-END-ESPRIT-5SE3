import mongoose from "mongoose";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { seed } from "./seed.js";
import { connectBus } from "./services/events.js";

await mongoose.connect(config.mongoUri);
console.info("[user-service] MongoDB connecté");
await seed();
await connectBus();

const server = createApp().listen(config.port, () =>
  console.info(`[user-service] http://localhost:${config.port}  (santé : /health)`),
);

const stop = () => server.close(() => mongoose.disconnect().then(() => process.exit(0)));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
