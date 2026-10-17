import { Router } from "express";
import * as authController from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.js";
import { authRateLimiter } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validation.js";
import { loginSchema, registerSchema, changePasswordSchema } from "../validation/index.js";

const router = Router();

/**
 * @route POST /api/auth/register
 * @desc Register a new resident account
 * @access Public (with rate limiting)
 */
router.post(
  "/register",
  authRateLimiter,
  validateBody(registerSchema),
  authController.register
);

/**
 * @route POST /api/auth/login
 * @desc Authenticate and receive JWT
 * @access Public (with rate limiting)
 */
router.post(
  "/login",
  authRateLimiter,
  validateBody(loginSchema),
  authController.login
);

/**
 * @route POST /api/auth/logout
 * @desc Logout and invalidate session
 * @access Private
 */
router.post("/logout", authenticate, authController.logout);

/**
 * @route GET /api/auth/me
 * @desc Get current user profile
 * @access Private
 */
router.get("/me", authenticate, authController.getMe);

/**
 * @route PUT /api/auth/change-password
 * @desc Change password
 * @access Private
 */
router.put(
  "/change-password",
  authenticate,
  authRateLimiter,
  validateBody(changePasswordSchema),
  authController.changePassword
);

export default router;
