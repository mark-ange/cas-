import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import type { Role as PrismaRole } from "@prisma/client";
import config from "../config/index.js";
import prisma from "../utils/prisma.js";
import logger from "../utils/logger.js";
import { hashPassword, comparePassword, validatePhoneNumber } from "../utils/password.js";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../utils/appError.js";
import type { AuthenticatedUser } from "../middleware/auth.js";

export interface RegisterPayload {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  barangayId: string;
  purokId?: string | null;
  waterOptIn: boolean;
  powerOptIn: boolean;
  privacyConsent: boolean;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface LoginResult {
  user: AuthenticatedUser;
  token: string;
}

/**
 * Generate a JWT token with a session identifier for revocation.
 */
export function generateToken(userId: string, role: string, sessionToken: string): string {
      return jwt.sign(
    { userId, role, sessionToken },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn } as any
  );
}

/**
 * Hash a session token for storage in the database.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Create a session record in the database for tracking and revocation.
 */
export async function createSession(userId: string): Promise<string> {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  return sessionToken;
}

/**
 * Validate that a session exists and is not revoked/expired.
 */
export async function validateSession(userId: string, sessionToken: string): Promise<boolean> {
  const tokenHash = hashSessionToken(sessionToken);
  const session = await prisma.session.findFirst({
    where: {
      userId,
      tokenHash,
      expiresAt: { gt: new Date() },
    },
  });
  return !!session;
}

/**
 * Delete a session (logout).
 */
export async function deleteSession(sessionToken: string): Promise<void> {
  const tokenHash = hashSessionToken(sessionToken);
  await prisma.session.deleteMany({ where: { tokenHash } });
}

export async function registerResident(payload: RegisterPayload): Promise<AuthenticatedUser> {
  // Enforce privacy consent on the backend
  if (!payload.privacyConsent) {
    throw new BadRequestError("You must accept the privacy notice to create an account");
  }

  // Validate and clean phone number
  const cleanedPhone = payload.phone.trim();
  if (!validatePhoneNumber(cleanedPhone)) {
    throw new BadRequestError("Enter a valid Philippine mobile number (e.g. +639123456789)");
  }

  const email = payload.email.toLowerCase().trim();
  const password = payload.password;

  if (password.length < 12) {
    throw new BadRequestError("Password must be at least 12 characters");
  }

  // Verify barangay exists and is active
  const barangay = await prisma.barangay.findUnique({ where: { id: payload.barangayId } });
  if (!barangay || !barangay.active) {
    throw new BadRequestError("Selected barangay is not available");
  }

  // Verify purok belongs to barangay if specified
  if (payload.purokId) {
    const purok = await prisma.purok.findUnique({ where: { id: payload.purokId } });
    if (!purok || purok.barangayId !== payload.barangayId) {
      throw new BadRequestError("Selected purok does not belong to the chosen barangay");
    }
  }

  // Check for existing user with this email
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError("An account with that email already exists");
  }

  const hashedPassword = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashedPassword,
      role: "RESIDENT" as PrismaRole,
      fullName: payload.fullName.trim(),
      phone: cleanedPhone,
      privacyConsent: true,
      privacyConsentAt: new Date(),
      residentProfile: {
        create: {
          barangayId: payload.barangayId,
          purokId: payload.purokId ?? null,
          waterOptIn: payload.waterOptIn,
          powerOptIn: payload.powerOptIn,
        },
      },
    },
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
    },
  });

  logger.info("Resident registered", { email: user.email });
  return mapToAuthenticatedUser(user, null);
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalizedEmail = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
      dispatcherProfile: true,
    },
  });

  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  if (!user.active) {
    throw new UnauthorizedError("Account is deactivated. Contact support.");
  }

  const passwordValid = await comparePassword(password, user.passwordHash);
  if (!passwordValid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const sessionToken = await createSession(user.id);
  const jwtToken = generateToken(user.id, user.role as string, sessionToken);

  logger.info("User logged in", { email: user.email });

  return {
    user: mapToAuthenticatedUser(user, null),
    token: jwtToken,
  };
}

export async function logout(sessionToken: string | undefined): Promise<void> {
  if (sessionToken) {
    await deleteSession(sessionToken);
  }
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");

  const passwordValid = await comparePassword(currentPassword, user.passwordHash);
  if (!passwordValid) throw new BadRequestError("Current password is incorrect");

  if (newPassword.length < 12) {
    throw new BadRequestError("Password must be at least 12 characters");
  }

  if (currentPassword === newPassword) {
    throw new BadRequestError("New password must be different from current password");
  }

  const hashedPassword = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hashedPassword } });
  await prisma.session.deleteMany({ where: { userId } });

  logger.info("Password changed", { userId });
}

export async function getCurrentUser(userId: string): Promise<AuthenticatedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
      dispatcherProfile: true,
    },
    });
  if (!user) return null;
  return mapToAuthenticatedUser(user, null);
}

/**
 * Map a Prisma user object to the AuthenticatedUser interface.
 */
export function mapToAuthenticatedUser(user: any, _sessionToken: string | null): AuthenticatedUser {
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
