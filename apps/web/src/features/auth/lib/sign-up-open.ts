/**
 * Mirrors the backend's `SIGNUP_INVITE_ONLY` (`backend/lunora/env.ts`): only
 * `"false"` or `"0"` open registration, anything else — unset included — keeps it
 * invite-only. The marketing pages use it to hide "try it free" / "sign up"
 * calls to action a visitor without an invitation could not follow through.
 */
export const isSignUpOpen = (value: string | undefined): boolean => value === "false" || value === "0";
