import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export type DeviceRoute = "relay" | "ssh-via-computer" | "this-computer";

export interface DeviceDiagnosticsInput {
    /** The browser or desktop shell user agent. */
    clientAgent: string;
    /** What the row shows about the last failed connection; reduced to a category here, never copied. */
    failure?: string;
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

// Checked in order, against both OpenSSH's wording and the device core's own (`packages/device-core/src/ssh.rs`). ssh ends
// a refused key with "Connection closed by authenticating user", which must read as a login, not as a closed connection.
const CONNECTION_CATEGORIES: ReadonlyArray<readonly [RegExp, MessageDescriptor]> = [
    [/remote host identification has changed|host key (?:of|for) .* changed|offending .* key/iu, msg`the host key changed`],
    [/host key verification failed|no matching host key|host key was not trusted|presented no host key/iu, msg`the host key could not be verified`],
    [/permission denied|refused the login|authenticat|passphrase|publickey/iu, msg`login refused`],
    [/timed out|timeout/iu, msg`timed out`],
    [/refused|unreachable|resolve|no route|lost|closed|reset/iu, msg`server not reachable`],
];

/** The core names the server first ("could not connect to me@login.example.com: …"): only what follows is the cause. */
const TARGET_PREFIX = /^could not connect to \S+: /iu;

/**
 * What ssh or a server said about a failed connection, as one of a few fixed phrases. That text can carry anything (a
 * password typed into a prompt, a banner, a key path), and no pattern recognises every secret, so it is never copied.
 */
export const connectionFailureCategory = (message: string, i18n: Pick<I18n, "_">): string => {
    const said = message.replace(TARGET_PREFIX, "");
    const found = CONNECTION_CATEGORIES.find(([pattern]) => pattern.test(said));

    return i18n._(found === undefined ? msg`connection failed` : found[1]);
};

/** The route as one translatable phrase; a name is a placeholder in it, so a translator can place it. */
const routeText = (route: DeviceRoute, viaName: string | undefined): MessageDescriptor => {
    switch (route) {
        case "relay": {
            return viaName === undefined ? msg`relay (another paired computer)` : msg`relay (another paired computer): ${viaName}`;
        }
        case "ssh-via-computer": {
            return viaName === undefined ? msg`SSH server via a paired computer` : msg`SSH server via a paired computer: ${viaName}`;
        }
        default: {
            return viaName === undefined ? msg`this computer` : msg`this computer: ${viaName}`;
        }
    }
};

/** One line each: a name with a line break must not be able to add a field of its own to the report. */
const oneLine = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();

/**
 * Plain text for a bug report, in the reader's language. It is built only from the fields above: the device's secret,
 * the signed envelopes, tokens and cookies never reach this function, so they cannot reach the text.
 */
export const buildDeviceDiagnostics = (input: DeviceDiagnosticsInput, i18n: Pick<I18n, "_">): string => {
    const name = oneLine(input.name);
    const client = oneLine(input.clientAgent);
    const route = i18n._(routeText(input.route, input.viaName ? oneLine(input.viaName) : undefined));
    const lastSeen = input.lastSeenAt === undefined ? i18n._(msg`never`) : new Date(input.lastSeenAt).toISOString();
    const failure = input.failure === undefined ? i18n._(msg`none`) : connectionFailureCategory(input.failure, i18n);

    return [
        i18n._(msg`Connection: ${name}`),
        i18n._(msg`Client: ${client}`),
        i18n._(msg`Route: ${route}`),
        i18n._(msg`Last seen: ${lastSeen}`),
        i18n._(msg`Last failure: ${failure}`),
    ].join("\n");
};
