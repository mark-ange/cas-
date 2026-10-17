import { z } from "zod";
import { ServiceType, Priority } from "@prisma/client";

/**
 * Validation schemas for advisory operations.
 */

export const advisoryStatusSchema = z.enum(
  ["SCHEDULED", "ACTIVE", "RESOLVED", "CANCELLED"]
);

const serviceTypeSchema = z.nativeEnum(ServiceType);
const prioritySchema = z.nativeEnum(Priority);

export const createAdvisorySchema = z.object({
  serviceType: serviceTypeSchema,
  priority: prioritySchema,
  title: z.string().min(3, "Title must be at least 3 characters").max(200, "Title must be at most 200 characters"),
  reason: z.string().min(1, "Reason is required").max(500, "Reason must be at most 500 characters").optional(),
  message: z.string().min(10, "Message must be at least 10 characters"),
  startAt: z.string().datetime("Enter a valid start date and time"),
  endAt: z
    .string()
    .datetime("Enter a valid end date and time")
    .optional()
    .nullable(),
  targets: z
    .array(
      z.object({
        barangayId: z.string().uuid("Invalid barangay ID"),
        purokIds: z.array(z.string().uuid("Invalid purok ID")).optional(),
      })
    )
    .min(1, "Select at least one affected location"),
});

export const previewAdvisorySchema = createAdvisorySchema;

export const publishAdvisorySchema = createAdvisorySchema.extend({
  previewId: z.string().uuid("A valid preview ID is required for publication"),
});

export const updateAdvisoryStatusSchema = z.object({
  status: advisoryStatusSchema,
  cancellationReason: z.string().max(500).optional(),
});

export const advisoryParamsSchema = z.object({
  id: z.string().uuid("Invalid advisory ID"),
});
