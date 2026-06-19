import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
export const PASSWORD_TOO_LONG = `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
export const PASSWORD_TOO_COMMON = "Password is too common — choose something less guessable";

/**
 * Trivially common passwords, rejected by exact (case-insensitive, trimmed)
 * match. Intentionally a short, dependency-free list — not a full breach
 * corpus. Exact match (not substring) avoids false positives like
 * "password1234" while still blocking the obvious defaults.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwerty123",
  "11111111",
  "00000000",
  "iloveyou",
  "letmein1",
  "welcome1",
  "changeme",
  "adminadmin",
  "admin123",
  "vaultvault",
  "vault123",
  "abcd1234",
  "1q2w3e4r",
  "trustno1",
  "superman",
  "baseball",
  "football",
  "monkey12",
]);

export type PasswordValidation = { ok: true } | { ok: false; reason: string };

/**
 * Centralized password policy used by the API (register), the admin
 * reset-password CLI, and the web client. Keep the failure strings stable —
 * tests and UI surface them directly.
 */
export function validatePassword(password: string): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: PASSWORD_TOO_SHORT };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, reason: PASSWORD_TOO_LONG };

  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) return { ok: false, reason: PASSWORD_TOO_COMMON };

  // Reject all-identical characters (e.g. "aaaaaaaa").
  if (password.length > 0 && new Set(password).size === 1) {
    return { ok: false, reason: PASSWORD_TOO_COMMON };
  }

  return { ok: true };
}

/**
 * Zod schema wrapping {@link validatePassword}, for routes that parse bodies
 * with zod. Surfaces the same reason strings via a single issue.
 */
export const passwordSchema = z.string().superRefine((value, ctx) => {
  const result = validatePassword(value);
  if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
});
