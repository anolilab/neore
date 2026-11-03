export type DeviceRoute = "relay" | "ssh-via-computer" | "this-computer";

export interface DeviceDiagnosticsInput {
    /** The client making the report (browser or desktop shell user agent). */
    appVersion: string;
    /** The size of the newest clock refusal for this connection, e.g. "about 12 minutes behind". */
    clockOffset?: string;
    /** Messages shown for this connection, newest last. Text only. */
    errors: string[];
    /** Version of the host program on the server, when the shell reported one. */
    hostVersion?: string;
    lastSeenAt?: number;
    name: string;
    route: DeviceRoute;
    /** Name of the paired computer that holds an SSH server. */
    viaName?: string;
}

/** An SSH server is reached through a paired computer; any other device is this computer or one paired elsewhere. */
export const routeOf = (transport: string | undefined, isThisComputer: boolean): DeviceRoute => {
    if (transport === "ssh") {
        return "ssh-via-computer";
    }

    return isThisComputer ? "this-computer" : "relay";
};

/** The messages for a row, newest last: the current reconnect reason, while one applies, is the newest. */
export const withReconnectReason = <T extends { message: string }>(remembered: T[], reason: string | null | undefined): { clockOffset?: string; message: string; }[] =>
    reason ? [...remembered, { message: reason }] : remembered;

const ROUTE_TEXT: Record<DeviceRoute, string> = {
    relay: "relay (another paired computer)",
    "ssh-via-computer": "SSH server via a paired computer",
    "this-computer": "this computer",
};

const MAX_ERROR_CHARS = 500;

/**
 * Plain text for a bug report. It is built only from the fields above: the device's secret, the signed
 * envelopes, tokens and cookies never reach this function, so they cannot reach the text.
 */
export const buildDeviceDiagnostics = (input: DeviceDiagnosticsInput): string => {
    const route = input.viaName ? `${ROUTE_TEXT[input.route]} (${input.viaName})` : ROUTE_TEXT[input.route];
    const errors = input.errors.map((message) => `  - ${message.slice(0, MAX_ERROR_CHARS).replaceAll(/\s+/g, " ")}`);

    return [
        `Connection: ${input.name}`,
        `App: ${input.appVersion}`,
        `Host version: ${input.hostVersion ?? "unknown"}`,
        `Route: ${route}`,
        `Last seen: ${input.lastSeenAt === undefined ? "never" : new Date(input.lastSeenAt).toISOString()}`,
        `Clock offset: ${input.clockOffset ?? "unknown"}`,
        errors.length > 0 ? `Last errors:\n${errors.join("\n")}` : "Last errors: none",
    ].join("\n");
};
