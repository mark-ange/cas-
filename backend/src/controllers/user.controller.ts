import type { Request, Response } from "express";
import * as userService from "../services/user.service.js";
import { sendSuccess, HttpStatus } from "../utils/apiResponse.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

/**
 * GET /api/users
 * List all users with optional filtering.
 * Admin-only.
 */
export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const { role, active, page, limit } = req.query as any;
  const result = await userService.listUsers({
    role,
    active: active !== undefined ? active === "true" : undefined,
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
  });
  sendSuccess(res, HttpStatus.OK, result);
});

/**
 * GET /api/users/:id
 * Get a single user.
 * Admin-only.
 */
export const getUser = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = await userService.getUserById(req.params.id!);
  sendSuccess(res, HttpStatus.OK, user);
});

/**
 * POST /api/users
 * Create a new user (admin/dispatcher).
 * Admin-only.
 */
export const createUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.createUser(req.body);
  sendSuccess(res, HttpStatus.CREATED, user, "User created successfully");
});

/**
 * PUT /api/users/:id
 * Update a user.
 * Admin-only.
 */
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.updateUser(req.params.id!, req.body);
  sendSuccess(res, HttpStatus.OK, user, "User updated successfully");
});

/**
 * PUT /api/users/:id/role
 * Assign a role to a user.
 * Admin-only.
 */
export const assignUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { role, serviceType } = req.body;
  const user = await userService.assignRole(req.params.id!, role, serviceType);
  sendSuccess(res, HttpStatus.OK, user, "Role assigned successfully");
});

/**
 * PATCH /api/users/:id/active
 * Activate or deactivate a user.
 * Admin-only.
 */
export const setUserActive = asyncHandler(async (req: Request, res: Response) => {
  const { active } = req.body;
  await userService.setUserActive(req.params.id!, active);
  sendSuccess(res, HttpStatus.OK, null, "User status updated");
});

/**
 * POST /api/users/:id/reset-password
 * Reset a user's password.
 * Admin-only.
 */
export const resetUserPassword = asyncHandler(async (req: Request, res: Response) => {
  const newPassword = await userService.resetPassword(req.params.id!);
  sendSuccess(res, HttpStatus.OK, { newPassword }, "Password reset successfully");
});
