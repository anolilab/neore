/**
 * The one reading of a catalogue entry's state, shared by the connectors
 * settings page and the skill builder's connector badges so the two cannot
 * disagree.
 */

export type ConnectorDisplayStatus = "connected" | "error" | "expired" | "not_configured" | "not_connected";

/** The fields of a `listConnectorCatalog` entry the status reads. */
export interface ConnectorStatusSource {
    configured: boolean;
    connection: {
        hasRefreshToken?: boolean;
        status: "connected" | "disconnected" | "error" | "expired";
        tokenExpiresAt?: number;
    } | null;
}

/**
 * A disconnected (or never made) connection reads as `not_connected`, or
 * `not_configured` when the operator set no client credentials. A token that
 * lapsed with no refresh token is expired even before any run has marked it so
 * — the backend cannot say, because a query must not read the clock.
 */
export const connectorDisplayStatus = (entry: ConnectorStatusSource, now: number): ConnectorDisplayStatus => {
    const { connection } = entry;

    if (connection && connection.status !== "disconnected") {
        const lapsed = connection.tokenExpiresAt !== undefined && connection.tokenExpiresAt <= now && !connection.hasRefreshToken;

        return lapsed ? "expired" : connection.status;
    }

    return entry.configured ? "not_connected" : "not_configured";
};
