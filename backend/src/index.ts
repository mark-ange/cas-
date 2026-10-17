import config from "./config/index.js";
import createApp from "./app.js";
import prisma from "./utils/prisma.js";
import logger from "./utils/logger.js";

const app = createApp();

const server = app.listen(config.backendPort, config.backendHost, () => {
  logger.info("🚀 Community Alert System backend running", {
    host: config.backendHost,
    port: config.backendPort,
    environment: config.nodeEnv,
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down gracefully");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
