import { Router } from "express";
import * as adminController from "../controllers/admin.controller.js";
import { authenticate } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { Role } from "@prisma/client";

const router = Router();

/**
 * @route GET /api/dashboard/admin
 * @desc Admin dashboard statistics
 * @access Admin only
 */
router.get("/admin", authenticate, authorize([Role.ADMIN]), adminController.getAdminStats);

/**
 * @route GET /api/dashboard/localities
 * @desc Locality statistics for admin
 * @access Admin only
 */
router.get(
  "/localities",
  authenticate,
  authorize([Role.ADMIN]),
  adminController.getLocalityStats
);

/**
 * @route GET /api/dashboard/dispatcher
 * @desc Dispatcher dashboard statistics
 * @access Dispatchers, Admin
 */
router.get(
  "/dispatcher",
  authenticate,
  authorize([Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN]),
  adminController.getDispatcherStats
);

/**
 * @route GET /api/dashboard/resident
 * @desc Resident dashboard (active advisories + notification stats)
 * @access Authenticated users
 */
router.get("/resident", authenticate, adminController.getResidentDashboard);

export default router;
