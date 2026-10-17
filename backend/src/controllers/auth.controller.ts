import type { Request, Response } from "express";
import * as authService from "../services/auth.service.js";
import { sendSuccess, sendError, HttpStatus } from "../utils/apiResponse.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

/**
 * POST /api/auth/register
 * Register a new resident account.
 */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const user = await authService.registerResident(req.body);
  sendSuccess(res, HttpStatus.CREATED, user, "Account registered successfully");
});

/**
 * POST /api/auth/login
 * Authenticate user and return JWT token (also set as HttpOnly cookie).
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const { user, token } = await authService.login(email, password);

  // Set JWT as HttpOnly cookie for additional security
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  sendSuccess(res, HttpStatus.OK, { user, token }, "Login successful");
});

/**
 * POST /api/auth/logout
 * Invalidate the current session and clear the JWT cookie.
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const sessionToken = req.session?.token;
  if (sessionToken) {
    await authService.logout(sessionToken);
  }

  res.clearCookie("token", {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  });

  sendSuccess(res, HttpStatus.OK, null, "Logged out successfully");
});

/**
 * GET /api/auth/me
 * Get the currently authenticated user's profile.
 */
export const getMe = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  if (!req.session?.user) {
    sendError(res, HttpStatus.UNAUTHORIZED, "Authentication required");
    return;
  }

  // Fetch fresh user data
  const user = await authService.getCurrentUser(req.session.user.id);
  if (!user) {
    sendError(res, HttpStatus.UNAUTHORIZED, "User not found");
    return;
  }

  sendSuccess(res, HttpStatus.OK, user);
});

/**
 * PUT /api/auth/change-password
 * Change the current user's password.
 */
export const changePassword = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const userId = req.session?.user?.id;
    if (!userId) {
    sendError(res, HttpStatus.UNAUTHORIZED, "Authentication required");
    return;
  }

  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(userId, currentPassword, newPassword);

  // Invalidate all sessions (forces re-login on other devices)
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  });

  sendSuccess(res, HttpStatus.OK, null, "Password changed. Please log in again.");
});
