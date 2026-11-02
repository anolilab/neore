/**
 * The text "Copy diagnostics" puts on the clipboard, for this computer or for one server. It is meant to be
 * pasted into a support request, so it is built from an allow-list of fields (never a whole view object) and
 * every free-text value — an ssh or sandbox message the server wrote — goes through `redact`.
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

const SECRET_ASSIGNMENT = /\b(?<name>\w*(?:secret|token|passphrase|passw(?:or)?d|apikey|api_key|authorization)\w*)\s*[:=]\s*(?:bearer\s+)?\S+/giu;
const BEARER = /\b(?:bearer|basic)\s+[\w.~+/=-]{8,}/giu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;
const KNOWN_TOKEN = /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA|eyJ)[\w.-]{12,}/gu;
const LONG_BLOB = /\b[\w+/=-]{40,}\b/gu;

const USER_FOLDER = /\/(?:Users|home)\/[^\s/]+/gu;
const WINDOWS_USER_FOLDER = /[A-Za-z]:\\Users\\[^\s\\]+/gu;
const WHITESPACE = /\s+/gu;
const TRAILING_SEPARATORS = /[/\\]$/u;

/** Free text made safe to paste: secrets and keys blanked, the home folder shortened to `~`, length capped. */
export const redact = (value: string, home: string): string => {
    let result = value.replaceAll(PRIVATE_KEY, "[key removed]").replaceAll(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[removed]`);

    result = result.replaceAll(BEARER, "[token removed]");
    result = result.replaceAll(KNOWN_TOKEN, "[token removed]").replaceAll(LONG_BLOB, "[removed]");

    const base = home.replace(TRAILING_SEPARATORS, "");

    if (base.length > 1) {
        result = result.split(base).join("~");
    }

    result = result.replaceAll(USER_FOLDER, "~").replaceAll(WINDOWS_USER_FOLDER, "~").replaceAll(WHITESPACE, " ").trim();

    return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT)}…` : result;
};

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

const routeLine = (host: HostView): string =>
    `Route: ${host.user}@${host.address}:${String(host.port)}, ${host.multiplexed ? "one shared ssh connection" : "one ssh process of its own"}, agent forwarding ${host.forwardAgent ? "on" : "off"}, ${host.identityFile === null ? "default keys" : "a chosen identity file"}`;

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
        routeLine(host),
        `Connection: ${host.connected ? "connected" : "not connected"}`,
        `Server platform: ${host.platform ?? "unknown"}`,
        `Coding agents: ${agentsLine(host.agentsSupported)}`,
        `Shell sandbox: ${host.sandboxDetail === null ? "not known" : redact(host.sandboxDetail, home)}`,
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
            lines.push(`Last error: ${redact(reconnect.reason, home)}`);
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

        return `- ${redact(host.name, home)}: ${state}${host.reconnect?.reason ? `, last error: ${redact(host.reconnect.reason, home)}` : ""}`;
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
