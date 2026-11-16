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

// Checked in order, against both OpenSSH's wording and the device core's own (`packages/device-core/src/ssh.rs`). Each row
// matches a whole phrase, never a single word, because the text also carries a server name ("authentication.example").
const CONNECTION_CATEGORIES: ReadonlyArray<readonly [RegExp, MessageDescriptor]> = [
    // A step on this computer failed, whatever its error says ("Permission denied (os error 13)"): no server refused anything.
    [/^(?:the passphrase channel failed|ssh-keyscan could not run|the host key could not be saved)/iu, msg`connection failed`],
    // Fixed core wording that ssh never prints, checked before a server name in it can match a login row.
    [/neore-host .* is not installed on/iu, msg`the host software is not installed`],
    [/the software there is out of date/iu, msg`the host software is out of date`],
    [/the host speaks protocol/iu, msg`the host software does not match this app`],
    [/host software is being upgraded/iu, msg`the host software is being upgraded`],
    [/remote host identification has changed|host key (?:of|for) .* changed|offending (?:\w+ )?key (?:for ip )?in/iu, msg`the host key changed`],
    [/host key verification failed|no matching host key|host key was not trusted|offered no usable host key/iu, msg`the host key could not be verified`],
    // ssh lists the methods it tried ("Permission denied (publickey,password)"); an OS error says "(os error 13)" instead.
    [
        /permission denied \((?!os error)|refused the login|closed by authenticating user|authentication failed|too many authentication failures|no more authentication methods|(?:bad|incorrect) passphrase/iu,
        msg`login refused`,
    ],
    [/timed out|did not answer in time/iu, msg`timed out`],
    [
        /connection refused|is unreachable|could not resolve|no route to host|connection was lost|connection closed|connection reset|closed by remote host|broken pipe|presented no host key/iu,
        msg`server not reachable`,
    ],
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
