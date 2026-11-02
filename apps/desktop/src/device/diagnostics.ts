/**
 * The text "Copy diagnostics" puts on the clipboard, for this computer or for one server. It is meant to be
 * pasted into a support request, so it is built from an allow-list of fields (never a whole view object) and
 * every free-text value the user typed goes through `redact`, while text a server or ssh wrote (the last error, the platform,
 * the sandbox detail) is reduced to a category because no pattern can recognise every secret in ssh's own text.
 * It holds no pairing or host secret, no key material, no token, and no path under the home folder.
 */
import type { HostView, SettingsView } from "./types";

export interface DiagnosticsContext {
    appVersion: string;
    arch: string;
    electronVersion: string;
    /** The user's home folder, hidden wherever it appears in a message. */
    home: string;
    now: Date;
    osRelease: string;
    platform: string;
}

const MAX_TEXT = 500;

const AUTHORIZATION_HEADER = /\b(?<name>(?:proxy-)?authorization)\s*[:=][^\n\r]*/giu;
const SECRET_NAME = String.raw`\b(?<name>\w*(?:secret|token|passphrase|passw(?:or)?d|apikey|api_key)\w*)\s*[:=]\s*`;
const SECRET_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:bearer\s+)?\S+)`;
const SECRET_ASSIGNMENT = new RegExp(SECRET_NAME + SECRET_VALUE, "giu");
const BEARER = /\b(?:bearer|basic)\s+[\w.~+/=-]{8,}/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;
const KNOWN_TOKEN = /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA|eyJ)[\w.-]{12,}/gu;
const LONG_BLOB = /(?<![\w+/=-])[\w+/=-]{40,}(?![\w+/=-])/gu;

const USER_FOLDER = /\/(?:Users|home)\/[^\s/]+/giu;
const WINDOWS_USER_FOLDER = /[a-z]:[\\/]Users[\\/][^\s\\/]+/giu;
const WINDOWS_STYLE_PATH = /^(?:[A-Za-z]:|\\\\)/u;
const PATH_SEPARATORS = /[\\/]+/u;
const REGEX_SPECIALS = /[$()*+.?[\\\]^{|}]/gu;
const WHITESPACE = /\s+/gu;
const TRAILING_SEPARATORS = /[/\\]$/u;

/** A Windows home folder, matched whatever the case and whichever slash the text uses. */
const windowsPrefix = (base: string): RegExp =>
    new RegExp(
        base
            .split(PATH_SEPARATORS)
            .map((part) => part.replaceAll(REGEX_SPECIALS, String.raw`\$&`))
            .join(String.raw`[\\/]+`),
        "giu",
    );

/** Free text made safe to paste: secrets and keys blanked, the home folder shortened to `~`, length capped. */
export const redact = (value: string, home: string): string => {
    let result = value
        .replaceAll(PRIVATE_KEY, "[key removed]")
        .replaceAll(AUTHORIZATION_HEADER, (_match, name: string) => `${name}=[removed]`)
        .replaceAll(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[removed]`);

    result = result.replaceAll(BEARER, "[token removed]");
    result = result.replaceAll(KNOWN_TOKEN, "[token removed]").replaceAll(LONG_BLOB, "[removed]");

    const base = home.replace(TRAILING_SEPARATORS, "");

    if (base.length > 1) {
        result = WINDOWS_STYLE_PATH.test(base) ? result.replaceAll(windowsPrefix(base), "~") : result.split(base).join("~");
    }

    result = result.replaceAll(WINDOWS_USER_FOLDER, "~").replaceAll(USER_FOLDER, "~").replaceAll(WHITESPACE, " ").trim();

    return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT)}…` : result;
};

const REASON_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/host key|remote host identification/iu, "the host key changed"],
    [/permission denied|authentication|passphrase|publickey|login/iu, "login refused"],
    [/timed out|timeout/iu, "timed out"],
    [/refused|unreachable|resolve|no route|lost|closed|reset/iu, "server not reachable"],
    [/255/u, "ssh exited with 255"],
];

/**
 * Why a connection gave up, as one of a few fixed phrases. The engine's reason is the ssh client's or the server's own
 * text, which can carry anything (a password typed into a prompt, a banner), and no pattern recognises every secret, so
 * the free text is never copied: only the category it falls into.
 */
export const reasonCategory = (reason: string): string => {
    const found = REASON_CATEGORIES.find(([pattern]) => pattern.test(reason));

    return found === undefined ? "connection failed" : found[1];
};

/** The operating system a server reported, as one of the names its host software uses, else `other`. */
const platformText = (platform: string | null): string => {
    if (platform === null) {
        return "unknown";
    }

    const name = platform.trim().toLowerCase();

    return ["linux", "macos", "windows"].includes(name) ? name : "other";
};

const SANDBOX_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Landlock ABI \d+$/u, "landlock"],
    [/^macOS sandbox-exec$/u, "sandbox-exec"],
    [/^this Linux kernel has no Landlock|^there is no shell sandbox|is missing$|^the sandbox needs \/proc\/self\/fd/u, "none"],
];

/**
 * What a server's sandbox probe said, as a fixed category. The detail is text the server wrote and can say anything, so
 * it is never copied: only the mechanism it names (the host software's own phrases), else `other`.
 */
export const sandboxCategory = (detail: string): string => {
    const found = SANDBOX_CATEGORIES.find(([pattern]) => pattern.test(detail.trim()));

    return found === undefined ? "other" : found[1];
};

/** An ssh user or address the person typed, redacted and cut down to the characters a login or host name can hold. */
const routeText = (value: string, home: string): string => redact(value, home).replaceAll(/[^\w.:@[\]-]/gu, "").slice(0, 255);

/** The clock as a person comparing two computers can read it: UTC time and this computer's offset from UTC. */
const clockLine = (now: Date): string => {
    const minutes = -now.getTimezoneOffset();
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);

    return `${now.toISOString()} (local offset UTC${sign}${String(Math.trunc(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")})`;
};

const header = (title: string, context: DiagnosticsContext): string[] => [
    `Neore diagnostics: ${title}`,
    `Neore: ${context.appVersion} (Electron ${context.electronVersion})`,
    `This computer: ${context.platform} ${context.arch}, OS ${context.osRelease}`,
    `Clock: ${clockLine(context.now)}`,
];

const routeLine = (host: HostView, home: string): string =>
    `Route: ${routeText(host.user, home)}@${routeText(host.address, home)}:${String(host.port)}, ${host.multiplexed ? "one shared ssh connection" : "one ssh process of its own"}, agent forwarding ${host.forwardAgent ? "on" : "off"}, ${host.identityFile === null ? "default keys" : "a chosen identity file"}`;

const agentsLine = (supported: boolean | null): string => {
    if (supported === null) {
        return "not known (not connected)";
    }

    return supported ? "supported by the host software" : "not supported by the host software; install or upgrade it";
};

const secondsUntil = (at: number, now: Date): string => {
    const seconds = Math.round((at - now.getTime()) / 1000);

    return String(Math.max(0, seconds));
};

const hostLines = (host: HostView, context: DiagnosticsContext): string[] => {
    const { home, now } = context;
    const lines = [
        `Server: ${redact(host.name, home)} (${host.deviceId})`,
        routeLine(host, home),
        `Connection: ${host.connected ? "connected" : "not connected"}`,
        `Server platform: ${platformText(host.platform)}`,
        `Coding agents: ${agentsLine(host.agentsSupported)}`,
        `Shell sandbox: ${host.sandboxDetail === null ? "not known" : sandboxCategory(host.sandboxDetail)}`,
        `Shell policy: sandbox ${host.requireShellSandbox ? "required" : "optional"}, network ${host.allowShellNetwork ? "allowed" : "blocked"}`,
        `Shared folders: ${String(host.roots.length)}`,
        `Registered agents: ${String(host.acpAgents.length)}`,
    ];
    const { reconnect } = host;

    if (reconnect !== null) {
        const attempt = reconnect.attempt === null ? "" : `, attempt ${String(reconnect.attempt)} of ${String(reconnect.maxAttempts)}`;
        const next = reconnect.nextAttemptAt === null ? "" : `, next attempt in ${secondsUntil(reconnect.nextAttemptAt, now)} s`;

        lines.push(`Reconnect: ${reconnect.phase}${attempt}${next}`);

        if (reconnect.reason !== null) {
            lines.push(`Last error: ${reasonCategory(reconnect.reason)}`);
        }
    }

    return lines;
};

/** Diagnostics for one server of the list, or `null` when it is not there. */
export const serverDiagnostics = (view: SettingsView, deviceId: string, context: DiagnosticsContext): string | null => {
    const host = view.hosts.find((candidate) => candidate.deviceId === deviceId);

    return host === undefined ? null : [...header(`server ${redact(host.name, context.home)}`, context), ...hostLines(host, context)].join("\n");
};

/** Diagnostics for this computer: its pairing and the state of every server, without their details. */
export const deviceDiagnostics = (view: SettingsView, context: DiagnosticsContext): string => {
    const { home, now } = context;
    const servers = view.hosts.map((host) => {
        const state = host.connected ? "connected" : host.reconnect?.phase ?? "not connected";

        return `- ${redact(host.name, home)}: ${state}${host.reconnect?.reason ? `, last error: ${reasonCategory(host.reconnect.reason)}` : ""}`;
    });

    return [
        ...header("this computer", context),
        `Paired: ${view.paired ? "yes" : "no"}`,
        `Shell sandbox: ${view.sandboxUnavailable === null ? "available" : redact(view.sandboxUnavailable, home)}`,
        `Shell policy: sandbox ${view.requireShellSandbox ? "required" : "optional"}, network ${view.shellNetwork}`,
        `Shared folders: ${String(view.roots.length)}`,
        `Local MCP servers: ${String(view.mcpServers.length)} (${String(view.mcpStatus.filter((status) => status.problem !== null).length)} with a problem)`,
        `Servers: ${String(view.hosts.length)}${servers.length > 0 ? `\n${servers.join("\n")}` : ""}`,
        `Taken at: ${now.toISOString()}`,
    ].join("\n");
};
