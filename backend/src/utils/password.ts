import bcrypt from "bcrypt";

// Bcrypt with 12 rounds is a good balance of security and performance
// for a prototype. Increase to 14+ for production.
const SALT_ROUNDS = 12;

// Philippine mobile number format: +63 or 0 followed by 9 digits starting with 9
// Examples: +639123456789, 09123456789
const PHONE_REGEX = /^(?:\+63|0)9\d{9}$/;

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePhoneNumber(phone: string): boolean {
  const cleaned = phone.trim();
  return PHONE_REGEX.test(cleaned);
}

export function maskPhoneNumber(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  // Show last 4 digits, mask the rest
  const visible = digits.slice(-4);
  const masked = "*".repeat(digits.length - 4);
  return `+${digits.slice(0, 2)} ${masked}${visible}`;
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PHONE_REGEX_STRING = PHONE_REGEX.source;
