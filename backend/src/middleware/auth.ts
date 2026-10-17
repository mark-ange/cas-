import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config/index.js";
import prisma from "../utils/prisma.js";
import logger from "../utils/logger.js";
import type { Role } from "@prisma/client";

export interface JwtPayload {
  userId: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
  phone: string;
  active: boolean;
  privacyConsent: boolean;
  barangayId: string | null;
  purokId: string | null;
  waterOptIn: boolean;
  powerOptIn: boolean;
  serviceType: string | null;
}

export interface SessionInfo {
  user: AuthenticatedUser;
  role: string;
  token: string;
}

/**
 * Middleware that extracts and verifies a JWT from the Authorization header
 * or cookies. If valid, loads the full user from the database and attaches
 * it to `req.session`. Does NOT reject unauthenticated requests — combine
 * with `authorize()` to enforce authentication.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;

    // Check token type prefix (e.g., "cas-access")
    if (payload === null || typeof payload !== "object" || !("userId" in payload)) {
      next();
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        residentProfile: { include: { barangay: true, purok: true } },
        dispatcherProfile: true,
      },
    });

    if (!user || !user.active) {
      next();
      return;
    }

    req.session = {
      user: mapUser(user),
      role: user.role as unknown as string,
      token,
    };
  } catch (error) {
    logger.warn("JWT verification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  next();
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  if (req.cookies?.token && typeof req.cookies.token === "string") {
    return req.cookies.token;
  }

  return null;
}

function mapUser(user: any): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role as unknown as string,
    fullName: user.fullName,
    phone: user.phone ?? "",
    active: user.active,
    privacyConsent: user.privacyConsent,
    barangayId: user.residentProfile?.barangayId ?? null,
    purokId: user.residentProfile?.purokId ?? null,
    waterOptIn: user.residentProfile?.waterOptIn ?? true,
    powerOptIn: user.residentProfile?.powerOptIn ?? true,
    serviceType: user.dispatcherProfile?.serviceType ?? null,
  };
}

