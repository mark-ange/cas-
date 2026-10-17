import express from "express";
import cookieParser from "cookie-parser";
import { corsMiddleware } from "./middleware/cors.js";
import { globalRateLimiter } from "./middleware/rateLimit.js";
import securityHeaders from "./middleware/securityHeaders.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authenticate } from "./middleware/auth.js";
import config from "./config/index.js";
import logger from "./utils/logger.js";
import apiRoutes from "./routes/index.js";

function createApp() {
  const app = express();

  // Trust proxy (for rate limiting behind reverse proxy)
  app.set("trust proxy", true);

  // Security headers
  app.use(securityHeaders);

  // CORS
  app.use(corsMiddleware);

  // Rate limiting
  app.use(globalRateLimiter);

  // Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Cookie parsing
  app.use(cookieParser());

  // Request logging (non-production)
  if (config.nodeEnv !== "production") {
    app.use((req, _res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        body: req.method !== "GET" ? req.body : undefined,
      });
      next();
    });
  }

  // JWT authentication — runs on every request, populates req.session if token present
  app.use(authenticate);

  // API routes
  app.use("/api", apiRoutes);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Endpoint not found" });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}

export default createApp;
