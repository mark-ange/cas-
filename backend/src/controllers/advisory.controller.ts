import type { Request, Response } from "express";
import * as advisoryService from "../services/advisory.service.js";
import { sendSuccess, HttpStatus } from "../utils/apiResponse.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

/**
 * POST /api/advisories/draft
 * Create a draft/preview of an advisory. Returns estimated recipient count.
 */
export const createDraft = asyncHandler(async (req: Request, res: Response) => {
  const draft = await advisoryService.createAdvisoryDraft(req.body, req.session!.user);
  sendSuccess(res, HttpStatus.OK, draft, "Draft created. Preview recipient count before publishing.");
});

/**
 * POST /api/advisories/draft/publish
 * Publish a previously-created draft.
 */
export const publishDraft = asyncHandler(async (req: Request, res: Response) => {
  const draft = req.body; // The full draft object sent from the frontend
  const advisory = await advisoryService.publishAdvisory(draft, req.session!.user);
  sendSuccess(res, HttpStatus.CREATED, advisory, "Advisory published successfully");
});

/**
 * GET /api/advisories
 * List advisories with optional filters.
 */
export const listAdvisories = asyncHandler(async (req: Request, res: Response) => {
  const { serviceType, status, dateFrom, dateTo, search, limit, offset } = req.query as any;
  const result = await advisoryService.listAdvisories({
    serviceType,
    status,
    dateFrom,
    dateTo,
    search,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  sendSuccess(res, HttpStatus.OK, result);
});

/**
 * GET /api/advisories/:id
 * Get a single advisory by ID.
 */
export const getAdvisory = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const advisory = await advisoryService.getAdvisoryById(req.params.id!, req.session!.user);
  sendSuccess(res, HttpStatus.OK, advisory);
});

/**
 * PATCH /api/advisories/:id/status
 * Update an advisory's status (e.g., to ACTIVE, RESOLVED, CANCELLED).
 */
export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const { status, cancellationReason } = req.body;
  const advisory = await advisoryService.updateAdvisoryStatus(
    req.params.id!,
    status,
    req.session!.user,
    cancellationReason
  );
  sendSuccess(res, HttpStatus.OK, advisory, "Advisory status updated");
});

/**
 * GET /api/advisories/:id/recipients
 * Get the list of recipients for an advisory.
 */
export const getRecipients = asyncHandler(async (req: Request, res: Response) => {
  const recipients = await advisoryService.getRecipientsForAdvisoryPublic(
    req.params.id!,
    req.session!.user
  );
  sendSuccess(res, HttpStatus.OK, recipients);
});
