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

/** What a server's row says about its sandbox. */
export const serverSandboxText = (status: McpServerStatus | undefined): string => {
    if (status === undefined) {
        return "";
    }

    if (status.problem !== null) {
        return `Cannot start: ${status.problem} `;
    }

    if (!status.sandboxed) {
        return "NOT sandboxed: runs with your full access (sandbox not required in the settings above); its network is not restricted. ";
    }

    // Sandboxed, but the tier it was given is not enforced here (the user allowed that): never read as plain "Sandboxed".
    return status.networkGap === null ? "Sandboxed. " : `Sandboxed, but its network is NOT restricted although its tier says so: ${status.networkGap}. `;
};

/** Whether the row is a warning rather than a footnote: not sandboxed, not startable, or sandboxed with its network open anyway. */
export const serverNeedsAttention = (status: McpServerStatus | undefined): boolean => status?.sandboxed !== true || status.networkGap !== null;
