import type { Request, Response } from "express";
import * as localityService from "../services/locality.service.js";
import { sendSuccess, HttpStatus } from "../utils/apiResponse.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

/**
 * GET /api/localities/barangays
 * List all active barangays with their puroks.
 */
export const getBarangays = asyncHandler(async (_req: Request, res: Response) => {
  const barangays = await localityService.getBarangays();
  sendSuccess(res, HttpStatus.OK, barangays);
});

/**
 * GET /api/localities/barangays/:id
 * Get a single barangay with its puroks.
 */
export const getBarangay = asyncHandler(async (req: Request, res: Response) => {
    const barangay = await localityService.getBarangayById(req.params.id!);
  sendSuccess(res, HttpStatus.OK, barangay);
});

/**
 * POST /api/localities/barangays
 * Create a new barangay (admin-only).
 */
export const createBarangay = asyncHandler(async (req: Request, res: Response) => {
  const barangay = await localityService.createBarangay(req.body);
  sendSuccess(res, HttpStatus.CREATED, barangay, "Barangay created successfully");
});

/**
 * PUT /api/localities/barangays/:id
 * Update a barangay (admin-only).
 */
export const updateBarangay = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
  const { name, active } = req.body;
  const barangay = await localityService.updateBarangay(id!, { name, active });
  sendSuccess(res, HttpStatus.OK, barangay, "Barangay updated successfully");
});

/**
 * GET /api/localities/barangays/:barangayId/puroks
 * List puroks for a barangay.
 */
export const getPuroks = asyncHandler(async (req: Request, res: Response) => {
    const puroks = await localityService.getPuroks(req.params.barangayId!);
  sendSuccess(res, HttpStatus.OK, puroks);
});

/**
 * POST /api/localities/puroks
 * Create a new purok (admin-only).
 */
export const createPurok = asyncHandler(async (req: Request, res: Response) => {
  const purok = await localityService.createPurok(req.body);
  sendSuccess(res, HttpStatus.CREATED, purok, "Purok created successfully");
});

/**
 * PUT /api/localities/puroks/:id
 * Update a purok (admin-only).
 */
export const updatePurok = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, active } = req.body;
    const purok = await localityService.updatePurok(id!, { name, active });
  sendSuccess(res, HttpStatus.OK, purok, "Purok updated successfully");
});
