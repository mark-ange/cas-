import { Router } from "express";
import * as localityController from "../controllers/locality.controller.js";
import { authenticate } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { Role } from "@prisma/client";

const router = Router();

/**
 * @route GET /api/localities/barangays
 * @desc List all active barangays with their puroks
 * @access Public
 */
router.get("/barangays", localityController.getBarangays);

/**
 * @route GET /api/localities/barangays/:id
 * @desc Get a single barangay with puroks
 * @access Public
 */
router.get("/barangays/:id", localityController.getBarangay);

/**
 * @route POST /api/localities/barangays
 * @desc Create a new barangay
 * @access Admin only
 */
router.post("/barangays", authenticate, authorize([Role.ADMIN]), localityController.createBarangay);

/**
 * @route PUT /api/localities/barangays/:id
 * @desc Update a barangay
 * @access Admin only
 */
router.put("/barangays/:id", authenticate, authorize([Role.ADMIN]), localityController.updateBarangay);

/**
 * @route GET /api/localities/barangays/:barangayId/puroks
 * @desc List puroks for a barangay
 * @access Public
 */
router.get("/barangays/:barangayId/puroks", localityController.getPuroks);

/**
 * @route POST /api/localities/barangays/:barangayId/puroks
 * @desc Create a new purok
 * @access Admin only
 */
router.post("/puroks", authenticate, authorize([Role.ADMIN]), localityController.createPurok);

/**
 * @route PUT /api/localities/puroks/:id
 * @desc Update a purok
 * @access Admin only
 */
router.put("/puroks/:id", authenticate, authorize([Role.ADMIN]), localityController.updatePurok);

export default router;
