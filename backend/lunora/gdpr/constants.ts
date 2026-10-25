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

/** Fixed and non-personal (no error text, email or user id), so it survives `minimiseGdprRecords`. */
export const POSTHOG_FAILED_MESSAGE = "Your account data was erased, but deleting your analytics profile failed.";

/** Delay before scheduled analytics-erasure retry 1, 2, 3, ...; after the last one the request stays failed. */
export const POSTHOG_RETRY_DELAYS_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000] as const;
export const POSTHOG_RETRY_MAX_ATTEMPTS = POSTHOG_RETRY_DELAYS_MS.length;

/** How long after an attempt starts the watchdog fails it if it recorded no outcome (crash or timeout mid-run). */
export const POSTHOG_RETRY_WATCHDOG_MS = 2 * 60 * 60 * 1000;

/**
 * How long a running attempt owns its claim. A delivery that finds the lease held leaves the attempt
 * alone; one that finds it lapsed (the first delivery died mid-run) takes the attempt over.
 */
export const POSTHOG_RETRY_LEASE_MS = 10 * 60 * 1000;
