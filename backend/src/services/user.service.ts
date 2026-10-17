import crypto from "node:crypto";
import type { Role as PrismaRole, ServiceType as PrismaServiceType } from "@prisma/client";
import prisma from "../utils/prisma.js";
import { hashPassword, validatePhoneNumber } from "../utils/password.js";
import logger from "../utils/logger.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/appError.js";

export interface CreateUserPayload {
  email: string;
  fullName: string;
  phone?: string;
  role: string;
  serviceType?: string | null;
  password?: string;
  barangayId?: string;
}

export interface UpdateUserPayload {
  fullName?: string;
  phone?: string;
  role?: string;
  serviceType?: string | null;
  active?: boolean;
}

function generateRandomPassword(): string {
  return crypto.randomBytes(12).toString("base64url").slice(0, 16);
}

/**
 * List all users with optional role/active filtering.
 */
export async function listUsers(params: {
  role?: string;
  active?: boolean;
  page?: number;
  limit?: number;
}): Promise<{ data: any[]; total: number }> {
  const where: any = {};
  if (params.role) where.role = params.role;
  if (params.active !== undefined) where.active = params.active;

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: params.limit,
      skip: params.page ? (params.page - 1) * (params.limit ?? 50) : 0,
      select: {
        id: true, email: true, fullName: true, role: true,
        phone: true, active: true, createdAt: true,
        residentProfile: { select: { barangayId: true, purokId: true } },
        dispatcherProfile: { select: { serviceType: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return { data, total };
}

/**
 * Get a single user by ID.
 */
export async function getUserById(id: string): Promise<any> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
      dispatcherProfile: true,
    },
  });
  if (!user) throw new NotFoundError("User not found");
    return user;
}

/**
 * Create a new user (admin/dispatcher). Passwords are generated if not provided.
 */
export async function createUser(payload: CreateUserPayload): Promise<any> {
  const email = payload.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ConflictError("A user with that email already exists");

  if (payload.phone && !validatePhoneNumber(payload.phone)) {
    throw new BadRequestError("Invalid phone number format");
  }

  const password = payload.password ?? generateRandomPassword();
  const hashedPassword = await hashPassword(password);

  const data: any = {
    email,
    passwordHash: hashedPassword,
    fullName: payload.fullName.trim(),
    role: payload.role as PrismaRole,
    phone: payload.phone ?? null,
  };

  if (payload.role === "RESIDENT") {
    if (!payload.barangayId) {
      throw new BadRequestError("Barangay is required for resident accounts");
    }
    data.residentProfile = {
      create: {
        barangayId: payload.barangayId,
        waterOptIn: true,
        powerOptIn: true,
      },
    };
  } else if (payload.serviceType) {
    data.dispatcherProfile = {
      create: { serviceType: payload.serviceType as PrismaServiceType },
    };
  }

  const user = await prisma.user.create({
    data,
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
      dispatcherProfile: true,
    },
  });

  logger.info("User created", { email: user.email, role: user.role });
  return { ...user, generatedPassword: password };
}

/**
 * Update an existing user.
 */
export async function updateUser(id: string, payload: UpdateUserPayload): Promise<any> {
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { dispatcherProfile: true, residentProfile: true },
  });
  if (!existing) throw new NotFoundError("User not found");

  const data: any = {
    fullName: payload.fullName?.trim(),
    phone: payload.phone,
    role: payload.role ? (payload.role as PrismaRole) : undefined,
    active: payload.active,
  };

  if (payload.role && payload.role !== existing.role) {
    if (["WATER_DISPATCHER", "POWER_DISPATCHER"].includes(payload.role)) {
      if (!existing.dispatcherProfile) {
        data.dispatcherProfile = {
          upsert: {
            create: { serviceType: payload.serviceType ?? "WATER" },
            update: { serviceType: payload.serviceType ?? "WATER" },
          },
        };
      } else if (payload.serviceType) {
        data.dispatcherProfile = {
          update: { serviceType: payload.serviceType },
        };
      }
    }
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    include: {
      residentProfile: { include: { barangay: true, purok: true } },
      dispatcherProfile: true,
    },
  });

  logger.info("User updated", { userId: id });
  return user;
}

/**
 * Deactivate or activate a user.
 */
export async function setUserActive(id: string, active: boolean): Promise<void> {
  await prisma.user.update({ where: { id }, data: { active } });
  logger.info(`User ${active ? "activated" : "deactivated"}`, { userId: id });
}

/**
 * Assign or update a user's role.
 */
export async function assignRole(id: string, role: string, serviceType?: string | null): Promise<any> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { dispatcherProfile: true },
  });
  if (!user) throw new NotFoundError("User not found");

  const data: any = { role: role as PrismaRole };

  const isNewDispatcher = ["WATER_DISPATCHER", "POWER_DISPATCHER"].includes(role);
  if (isNewDispatcher) {
    if (!user.dispatcherProfile) {
      data.dispatcherProfile = {
        create: { serviceType: serviceType ?? "WATER" },
      };
    } else if (serviceType) {
      data.dispatcherProfile = {
        update: { serviceType: serviceType },
      };
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    include: { dispatcherProfile: true },
  });

  logger.info("Role assigned", { userId: id, role });
  return updated;
}

/**
 * Reset a user's password (admin-initiated). Returns the new password.
 */
export async function resetPassword(id: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError("User not found");

  const newPassword = generateRandomPassword();
  const hashedPassword = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id },
    data: { passwordHash: hashedPassword },
  });

  await prisma.session.deleteMany({ where: { userId: id } });

  logger.info("Password reset", { userId: id });
  return newPassword;
}
