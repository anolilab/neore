/**
 * Centralized constants for the application
 *
 * This file contains all magic strings, numbers, and other constants
 * used throughout the codebase to improve maintainability and DRY principles.
 */

// Organization limits
export const MEMBER_LIMIT = 5;
export const DEFAULT_LIST_LIMIT = 100;
export const DEFAULT_PLAN = "free";
export const ORGANIZATION_LIMIT = 3;
export const MEMBERSHIP_LIMIT = 100;

// Time constants (in milliseconds)
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Plans
export const PLANS = {
    FREE: "free",
    PREMIUM: "premium",
} as const;

// Invitation expiration (7 days in seconds)
export const INVITATION_EXPIRATION_SECONDS = 7 * 24 * 60 * 60;

// Rate limit periods
export const RATE_LIMIT_PERIODS = {
    DAY: ONE_DAY_MS,
    HOUR: ONE_HOUR_MS,
    MINUTE: 60 * 1000,
} as const;
