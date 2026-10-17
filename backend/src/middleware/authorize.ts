import type { Request, Response, NextFunction } from "express";
import { sendError, HttpStatus } from "../utils/apiResponse.js";
import type { Role } from "@prisma/client";

/**
 * Middleware factory that enforces role-based authorization.
 * Usage: authorize([Role.ADMIN]) or authorize([Role.WATER_DISPATCHER, Role.ADMIN])
 */
export function authorize(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    if (!req.session || !req.session.user) {
      return sendError(res, HttpStatus.UNAUTHORIZED, "Authentication required");
    }

    if (!allowedRoles.includes(req.session.role as unknown as Role)) {
      return sendError(
        res,
        HttpStatus.FORBIDDEN,
        "Your account does not have permission to perform this action"
      );
    }

    next();
  };
}

