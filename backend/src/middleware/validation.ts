import type { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { sendError, HttpStatus } from "../utils/apiResponse.js";

/**
 * Zod validation middleware.
 * Validates req.body against the provided schema.
 * On failure, returns 400 with the first validation error message.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        const issues = (error as any).issues;
        const firstMessage = issues[0]?.message || "Validation failed";
        sendError(res, HttpStatus.BAD_REQUEST, firstMessage);
        return;
      }
      next(error);
    }
  };
}

/**
 * Validates query parameters against a Zod schema.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.query = schema.parse(req.query) as any;
      next();
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        const issues = (error as any).issues;
        const firstMessage = issues[0]?.message || "Invalid query parameters";
        sendError(res, HttpStatus.BAD_REQUEST, firstMessage);
        return;
      }
      next(error);
    }
  };
}

/**
 * Validates route parameters against a Zod schema.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.params = schema.parse(req.params) as any;
      next();
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        const issues = (error as any).issues;
        const firstMessage = issues[0]?.message || "Invalid parameters";
        sendError(res, HttpStatus.BAD_REQUEST, firstMessage);
        return;
      }
      next(error);
    }
  };
}
