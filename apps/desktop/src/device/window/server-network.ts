import type { McpServerStatus, NetworkTier, SettingsView } from "../types";

type Availability = Pick<SettingsView, "dependenciesUnavailable">;

/** Whether a tier can be chosen on this computer: "Common dependencies only" cannot be enforced everywhere. */
export const tierAvailable = (tier: NetworkTier, view: Availability): boolean => tier !== "dependencies" || view.dependenciesUnavailable === null;

/** The tier a new server starts on: the middle one only where this computer can enforce it, else Off. */
export const defaultServerTier = (view: Availability): NetworkTier => view.dependenciesUnavailable === null ? "dependencies" : "off";

/**
 * A server that will start without a sandbox (Windows, or no sandbox and "Require sandbox" off) is not held to any
 * tier, whatever is stored for it, so its row must not offer one as if it were enforced.
 */
export const networkUnrestricted = (status: McpServerStatus | undefined): boolean => status !== undefined && status.problem === null && !status.sandboxed;
