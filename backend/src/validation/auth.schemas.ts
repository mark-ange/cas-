import { z } from "zod";

/**
 * Shared validation schemas for user registration and authentication.
 */

// Philippine mobile number: +639XXXXXXXXX or 09XXXXXXXXX
export const phoneSchema = z
  .string()
  .min(11, "Enter a valid Philippine mobile number")
  .max(16, "Phone number is too long")
  .refine(
    (val) => /^(?:\+63|0)9\d{9}$/.test(val.replace(/\s/g, "")),
    "Enter a valid Philippine mobile number (e.g. +639123456789)"
  );

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters");

export const emailSchema = z
  .string()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email address");

export const fullNameSchema = z
  .string()
  .min(2, "Full name must be at least 2 characters")
  .max(80, "Full name must be at most 80 characters");

export const uuidSchema = z.string().uuid("Invalid ID");

export const registerSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
  barangayId: uuidSchema,
  purokId: uuidSchema.optional(),
  waterOptIn: z.boolean().default(true),
  powerOptIn: z.boolean().default(true),
  privacyConsent: z.boolean().refine((val) => val === true, {
    message: "You must accept the privacy notice to create an account",
  }),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  fullName: fullNameSchema.optional(),
  phone: phoneSchema.optional(),
  barangayId: uuidSchema.optional(),
  purokId: uuidSchema.nullable().optional(),
  waterOptIn: z.boolean().optional(),
  powerOptIn: z.boolean().optional(),
});
