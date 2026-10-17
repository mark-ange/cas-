import type { Request, Response, NextFunction } from "express";

/**
 * Wraps an async route handler and forwards errors to the next error middleware.
 */
export function asyncHandler<T = unknown>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
