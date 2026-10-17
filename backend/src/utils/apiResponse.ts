import type { Response } from "express";

export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const;

type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus];

/**
 * Standardized API response envelope.
 * Success: { data: T, message?: string }
 * Error:   { error: string }
 */
export interface ApiSuccess<T> {
  data: T;
  message?: string;
}

export interface ApiErrorBody {
  error: string;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiErrorBody;

/**
 * Send a standardized success response.
 */
export function sendSuccess<T>(
  res: Response,
  statusCode: HttpStatusCode,
  data: T,
  message?: string
): Response {
  const body: ApiSuccess<T> = { data };
  if (message) body.message = message;
  return res.status(statusCode).json(body);
}

export function sendError(
  res: Response,
  statusCode: HttpStatusCode,
  message: string
): Response {
  return res.status(statusCode).json({ error: message });
}
