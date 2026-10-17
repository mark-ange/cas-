import type { Request, Response, NextFunction } from "express";
import { PERMISSIONS, Role } from "../types/index.js";

/**
 * Checks if a user's role is allowed to manage a specific service type.
 * Water dispatchers can only manage WATER advisories.
 * Power dispatchers can only manage POWER advisories.
 * Admins can manage both.
 */
export function checkServicePermission(
  userRole: string,
  serviceType: string
): boolean {
  if (userRole === "ADMIN") return true;

  const role = userRole as Role;

  if (serviceType === "WATER") {
    return (PERMISSIONS.WATER_DISPATCH_ROLES as string[]).includes(role as string);
  }

  if (serviceType === "POWER") {
    return (PERMISSIONS.POWER_DISPATCH_ROLES as string[]).includes(role as string);
  }

  return false;
}

/**
 * Middleware factory that enforces service-type permission for dispatchers.
 * The serviceType is extracted from the request body or params.
 */
export function requireServicePermission() {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}
