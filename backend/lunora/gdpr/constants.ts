export const EXPORT_EXPIRY_DAYS = 7;
export const EXPORT_EXPIRY_MS = EXPORT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export const DELETION_RETENTION_DAYS = 30;
export const DELETION_RETENTION_MS = DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const GDPR_REQUEST_TIMEOUT_DAYS = 30;
export const GDPR_REQUEST_TIMEOUT_MS = GDPR_REQUEST_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;

/**
 * How recently the caller must have signed in to request account deletion.
 * better-auth's default `session.freshAge` (auth.ts does not override it), and
 * the web app's `freshAge` default — keep the three in step.
 */
export const DELETION_SESSION_FRESH_AGE_MS = 24 * 60 * 60 * 1000;

/** Owner written onto ledger rows of a deleted account (`auth/gdpr.ts`, `gdpr/steps/residual-deletion-steps.ts`). */
export const DELETED_USER_MARKER = "deleted-user";
