import { Router } from "express";
import * as userController from "../controllers/user.controller.js";
import { authenticate } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { Role } from "@prisma/client";

const router = Router();

router.use(authenticate, authorize([Role.ADMIN]));

/**
 * @route GET /api/users
 * @desc List all users
 * @access Admin
 */
router.get("/", userController.listUsers);

/**
 * @route POST /api/users
 * @desc Create a new user
 * @access Admin
 */
router.post("/", userController.createUser);

/**
 * @route GET /api/users/:id
 * @desc Get a single user
 * @access Admin
 */
router.get("/:id", userController.getUser);

/**
 * @route PUT /api/users/:id
 * @desc Update a user
 * @access Admin
 */
router.put("/:id", userController.updateUser);

/**
 * @route PUT /api/users/:id/role
 * @desc Assign role to a user
 * @access Admin
 */
router.put("/:id/role", userController.assignUserRole);

/**
 * @route PATCH /api/users/:id/active
 * @desc Activate/deactivate a user
 * @access Admin
 */
router.patch("/:id/active", userController.setUserActive);

/**
 * @route POST /api/users/:id/reset-password
 * @desc Reset a user's password
 * @access Admin
 */
router.post("/:id/reset-password", userController.resetUserPassword);

export default router;
