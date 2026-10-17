import { z } from "zod";

/**
 * Validation schemas specifically for locality (barangay/purok) endpoints.
 */

export const localityParamsSchema = z.object({
  barangayId: z.string().uuid("Invalid barangay ID"),
  purokId: z.string().uuid("Invalid purok ID"),
});

export const searchParamsSchema = z.object({
  q: z.string().optional(),
  active: z.enum(["true", "false"]).optional(),
});
