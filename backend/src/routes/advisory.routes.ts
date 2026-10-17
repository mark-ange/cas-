import { Router } from "express";
import * as advisoryController from "../controllers/advisory.controller.js";
import { authenticate } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { Role } from "@prisma/client";
import { validateBody } from "../middleware/validation.js";
import { createAdvisorySchema } from "../validation/index.js";

const router = Router();

// All advisory routes require authentication
router.use(authenticate);

/**
 * @route POST /api/advisories/draft
 * @desc Create a draft/preview with estimated recipient count
 * @access Dispatchers, Admin
 */
router.post(
  "/draft",
  authorize([Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN]),
  validateBody(createAdvisorySchema),
  advisoryController.createDraft
);

/**
 * @route POST /api/advisories/draft/publish
 * @desc Publish a draft advisory
 * @access Dispatchers, Admin
 */
router.post(
  "/draft/publish",
  authorize([Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN]),
  advisoryController.publishDraft
);

/**
 * @route GET /api/advisories
 * @desc List advisories with filters
 * @access All authenticated users
 */
router.get("/", advisoryController.listAdvisories);

/**
 * @route GET /api/advisories/:id
 * @desc Get a single advisory
 * @access Dispatchers, Admin, or the creator
 */
router.get("/:id", advisoryController.getAdvisory);

/**
 * @route PATCH /api/advisories/:id/status
 * @desc Update advisory status
 * @access Dispatchers, Admin
 */
router.patch(
  "/:id/status",
  authorize([Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN]),
  advisoryController.updateStatus
);

/**
 * @route GET /api/advisories/:id/recipients
 * @desc Get recipient list for an advisory
 * @access Dispatchers, Admin
 */
router.get(
  "/:id/recipients",
  authorize([Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN]),
  advisoryController.getRecipients
);

export default router;
