/**
 * Time-boxed tool allows ("Allow for 1 hour" / "Allow for today").
 *
 * A grant is a tool permission KEY mapped to the instant it lapses, kept in
 * `aiUserPreferences.toolPermissionGrants` — apart from `toolPermissions`, so a
 * lapsed grant leaves the stored override exactly as the user set it. A grant
 * only turns an `ask` into an `auto` for an interactive run
 * (`resolveToolPermission`); it never overrides `off`, and a headless run never
 * sees it.
 */
import { localParts, resolveTimeZone, zonedTimeToUtc } from "../../memory/reflection-logic";

export type ToolPermissionGrants = Record<string, number>;

export type TimedGrantKind = "hour" | "today";

export const GRANT_HOUR_MS = 60 * 60 * 1000;

/** Keys one user can hold at once; a write prunes lapsed entries first. */
export const MAX_TOOL_GRANTS = 100;

/** Tools that never take a time-boxed allow: a question hard-codes a person, and a device call is approved again on the device. */
const isDeviceKey = (key: string): boolean => key.startsWith("device:");

const PERSON_KEYS: ReadonlySet<string> = new Set(["builtin:askUser"]);

export const isGrantableKey = (key: string): boolean => !isDeviceKey(key) && !PERSON_KEYS.has(key);

/**
 * When a grant of `kind` made at `now` lapses. `today` ends at the user's next
 * local midnight; an unset or unknown timezone reads as UTC.
 */
export const grantExpiry = (kind: TimedGrantKind, now: number, timezone: string | null | undefined): number => {
    if (kind === "hour") {
        return now + GRANT_HOUR_MS;
    }

    const zone = resolveTimeZone(timezone);
    const { day, month, year } = localParts(now, zone);
    const midnight = zonedTimeToUtc(year, month, day + 1, 0, 0, zone);

    return midnight > now ? midnight : now + GRANT_HOUR_MS;
};

/** The entries still in force at `now`. */
export const activeGrants = (grants: ToolPermissionGrants | null | undefined, now: number): ToolPermissionGrants =>
    Object.fromEntries(Object.entries(grants ?? {}).filter(([, expiresAt]) => expiresAt > now));

/** The expiry of the grant covering `key` at `now`, if any. */
export const grantExpiryFor = (grants: ToolPermissionGrants | null | undefined, key: string, now: number): number | undefined => {
    const expiresAt = grants?.[key];

    return expiresAt !== undefined && expiresAt > now && isGrantableKey(key) ? expiresAt : undefined;
};
