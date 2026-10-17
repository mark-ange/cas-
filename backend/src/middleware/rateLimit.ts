import rateLimit from "express-rate-limit";
import config from "../config/index.js";

/**
 * Global rate limiter — applied to all routes.
 */
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
     skip: (req) => req.method === "OPTIONS",
  message: {
    error: "Too many requests. Please try again later.",
  },
});

/**
 * Stricter rate limiter for sensitive endpoints (login, registration).
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many attempts. Please wait a few minutes and try again.",
  },
});

/**
 * Rate limiter for password changes.
 */
export const passwordRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many password change attempts. Please try again later.",
  },
});
