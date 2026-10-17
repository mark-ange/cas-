import { z } from "zod";
import { Role, ServiceType } from "@prisma/client";

/**
 * Validation schemas for user and locality administration.
 */

export const roleSchema = z.nativeEnum(Role);
export const serviceTypeSchema = z.nativeEnum(ServiceType);

export const createUserSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  fullName: z.string().min(2).max(80),
  phone: z.string().optional(),
  role: roleSchema,
  serviceType: serviceTypeSchema.optional(),
  password: z.string().min(12).max(128),
});

export const updateUserSchema = z.object({
  fullName: z.string().min(2).max(80).optional(),
  phone: z.string().optional(),
  role: roleSchema.optional(),
  serviceType: serviceTypeSchema.optional(),
  active: z.boolean().optional(),
});

export const assignRoleSchema = z.object({
  role: roleSchema,
  serviceType: serviceTypeSchema.optional(),
});

export const activateUserSchema = z.object({
  active: z.boolean(),
});

export const barangaySchema = z.object({
  name: z.string().min(1, "Barangay name is required").max(100),
  city: z.string().max(100).default("Cagayan de Oro City"),
  active: z.boolean().optional(),
});

export const purokSchema = z.object({
  name: z.string().min(1, "Purok name is required").max(100),
  barangayId: z.string().uuid("Invalid barangay ID"),
  active: z.boolean().optional(),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const notificationTypeSchema = z.enum(["ADVISORY", "RESTORATION", "CANCELLATION"]);
export const deliveryStatusSchema = z.enum(["QUEUED", "SIMULATED", "FAILED"]);
