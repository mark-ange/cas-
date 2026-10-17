import type { ErrorRequestHandler } from "express";
import logger from "../utils/logger.js";

export interface ApiError extends Error {
  status?: number;
  statusCode?: number;
}

/**
 * Centralized error handler.
 * - Logs the error with stack (server-side only).
 * - Returns a generic message to the client.
 * - Never exposes stack traces, internal DB details, or secrets.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = (err as ApiError).status ?? (err as ApiError).statusCode ?? 500;
  const message = err.message || "Internal server error";

  // Log full details server-side
  logger.error(message, {
    status,
    stack: config.nodeEnv !== "production" ? err.stack : undefined,
  });

  // Send safe response
  if (status >= 500) {
    res.status(status).json({ error: "Internal server error" });
  } else {
    res.status(status).json({ error: message });
  }
};

import config from "../config/index.js";
