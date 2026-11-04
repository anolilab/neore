import { t } from "@lingui/core/macro";

import type { ClockOffset } from "./device-errors";

export type DeviceRoute = "relay" | "ssh-via-computer" | "this-computer";

export interface DeviceDiagnosticsInput {
    /** The Neore build, when an authoritative source has one; the web app is not given one by the shell yet. */
    appVersion?: string;
    /** The browser or desktop shell user agent. */
    clientAgent: string;
    /** The size of the newest clock refusal for this connection, e.g. "about 12 minutes behind". */
    clockOffset?: ClockOffset;
    /** Messages shown for this connection, newest last. A connection one is reduced to a category here. */
    errors: { kind: "connection" | "service"; message: string }[];
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

const CONNECTION_CATEGORIES: ReadonlyArray<readonly [RegExp, () => string]> = [
    [/host key|remote host identification/iu, () => t`the host key changed`],
    [/permission denied|authentication|passphrase|publickey|login/iu, () => t`login refused`],
    [/timed out|timeout/iu, () => t`timed out`],
    [/refused|unreachable|resolve|no route|lost|closed|reset/iu, () => t`server not reachable`],
];

/**
 * What ssh or a server said about a failed connection, as one of a few fixed phrases. That text can carry anything (a
 * password typed into a prompt, a banner, a key path), and no pattern recognises every secret, so it is never copied.
 */
export const connectionFailureCategory = (message: string): string => {
    const found = CONNECTION_CATEGORIES.find(([pattern]) => pattern.test(message));

    return found === undefined ? t`connection failed` : found[1]();
};

const routeText = (route: DeviceRoute): string => {
    switch (route) {
        case "relay": {
            return t`relay (another paired computer)`;
        }
        case "ssh-via-computer": {
            return t`SSH server via a paired computer`;
        }
        default: {
            return t`this computer`;
        }
    }
};

const clockOffsetText = ({ direction, minutes }: ClockOffset): string =>
    direction === "ahead" ? t`about ${minutes} minutes ahead` : t`about ${minutes} minutes behind`;

const MAX_ERROR_CHARS = 500;

/**
 * Plain text for a bug report. It is built only from the fields above: the device's secret, the signed
 * envelopes, tokens and cookies never reach this function, so they cannot reach the text.
 */
export const buildDeviceDiagnostics = (input: DeviceDiagnosticsInput): string => {
    // One line each: a name with a line break must not be able to add a field of its own to the report.
    const oneLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();
    const name = oneLine(input.name);
    const route = input.viaName ? `${routeText(input.route)} (${oneLine(input.viaName)})` : routeText(input.route);
    const errors = input.errors.map((error) => {
        const text = error.kind === "connection" ? connectionFailureCategory(error.message) : error.message;

        return `  - ${text.slice(0, MAX_ERROR_CHARS).replaceAll(/\s+/g, " ")}`;
    });
    const unknown = t`unknown`;
    const clockOffset = input.clockOffset ? clockOffsetText(input.clockOffset) : unknown;
    const lastSeen = input.lastSeenAt === undefined ? t`never` : new Date(input.lastSeenAt).toISOString();

    return [
        t`Connection: ${name}`,
        t`App version: ${input.appVersion ?? unknown}`,
        t`Client: ${input.clientAgent}`,
        t`Host version: ${input.hostVersion ?? unknown}`,
        t`Route: ${route}`,
        t`Last seen: ${lastSeen}`,
        t`Clock offset: ${clockOffset}`,
        errors.length > 0 ? `${t`Last errors:`}\n${errors.join("\n")}` : t`Last errors: none`,
    ].join("\n");
};
