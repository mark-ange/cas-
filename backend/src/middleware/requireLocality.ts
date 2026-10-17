import type { Request, Response, NextFunction } from "express";
import { sendError, HttpStatus } from "../utils/apiResponse.js";

/**
 * Requires that the authenticated user has selected a complete locality
 * (barangay + optional purok). Used for resident-profile endpoints.
 */
export function requireLocality(
  req: Request,
  _res: Response,
  next: NextFunction
): void | Response {
  if (!req.session?.user) {
    return sendError(
      _res,
      HttpStatus.UNAUTHORIZED,
      "Authentication required"
    );
  }

  if (!req.session.user.barangayId) {
    return sendError(
      _res,
      HttpStatus.BAD_REQUEST,
      "Please complete your barangay selection in your profile"
    );
  }

  next();
}
