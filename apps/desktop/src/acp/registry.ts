/**
 * The official ACP agent registry, read by the desktop main process (never the page, never the backend, which
 * would learn what the user installs): a JSON file on the protocol's CDN listing agents and, for some, the
 * archives to download. Documented at https://agentclientprotocol.com/get-started/registry; the entry format is
 * `agent.schema.json` in the `agentclientprotocol/registry` repository.
 *
 * An agent is installable here when it has a `binary` download for this platform WITH a published SHA-256, or an
 * `npx` entry that names an exact npm version: that one is installed pinned and checked against the integrity the
 * npm package index publishes for the version (trust on first use, shown before the person confirms), never
 * resolved when it starts. Without a checksum, and for `uvx`, nothing shows the file is the one the publisher
 * released, so those are listed, with the reason, and not installable.
 */

import { isPrivateHost } from "./private-host";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const REGISTRY_TIMEOUT_MS = 15_000;
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
/** A search result older than this is not installed from: the user searches again and sees what is current. */
const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
/** A search inside this window filters the last answer instead of fetching up to 5 MiB again. */
const SNAPSHOT_REUSE_MS = 60_000;
const MAX_RESULTS = 50;
/** The registry's `id` pattern, and the longest key the core accepts. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const SHA256 = /^[a-f0-9]{64}$/iu;
const ARCHIVE_SUFFIXES: ReadonlyArray<[string, ArchiveFormat]> = [
    [".tar.gz", "tar.gz"],
    [".tgz", "tar.gz"],
    [".zip", "zip"],
];
const UNSUPPORTED_SUFFIXES = [".tar.bz2", ".tbz2", ".dmg", ".pkg", ".deb", ".rpm", ".msi", ".appimage", ".tar.xz", ".tar.zst", ".7z"];
// The core refuses what these refuse (`acp.rs`, `acp_install.rs`), and stays the authority; checking here lists
// an entry as not installable with a reason, before a download.
const VERSION = /^\d[\dA-Za-z.+-]{0,39}$/u;
const ENV_NAME = /^[A-Z_a-z]\w{0,127}$/u;
const PATH_SEPARATOR = /[/\\]/u;
const LEADING_DOT_SLASH = /^\.[/\\]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const MAX_ARGS = 50;
const MAX_ARG_BYTES = 1000;
const MAX_ENV_VALUE_BYTES = 8 * 1024;
/** The core's limits on all of an entry's variables together (`MAX_ENV_VARS`, `MAX_ENV_TOTAL_BYTES`). */
const MAX_ENV_VARS = 50;
const MAX_ENV_TOTAL_BYTES = 32 * 1024;
const MAX_PUBLISHER = 200;
const MAX_SOURCE = 1000;
const RESERVED_ENV_PREFIXES = ["NEORE_", "ELECTRON_"];
/** Variables that decide which code a program runs: an install may not set them. */
const CODE_LOADING_ENV_NAMES = new Set(["_JAVA_OPTIONS", "BASH_ENV", "CLASSPATH", "COMSPEC", "ELECTRON_RUN_AS_NODE", "ENV", "GCONV_PATH", "IFS", "JDK_JAVA_OPTIONS", "NODE_OPTIONS", "PATH", "PATHEXT", "PROMPT_COMMAND", "RUBYGEMS_GEMDEPS", "ZDOTDIR"]);
const CODE_LOADING_ENV_PREFIXES = ["BUNDLE_", "DYLD_", "GEM_", "GIT_", "JAVA", "LD_", "NODE_", "NPM_", "PERL", "PHP", "PYTHON", "RUBY"];
const CONTROL_CHARACTER = /\p{Cc}/u;
const GITHUB_OWNER = /^https:\/\/github\.com\/([^/]+)\//u;

export type ArchiveFormat = "raw" | "tar.gz" | "zip";

export interface BinaryTarget {
    archive: string;
    args: string[];
    cmd: string;
    env: Record<string, string>;
    sha256?: string;
}

/** An agent distributed as an npm package: `npx &lt;package> &lt;args>`. */
export interface NpxDistribution {
    args: string[];
    env: Record<string, string>;
    /** As the registry wrote it, `name@version`. */
    package: string;
}

export interface RegistryAgent {
    binary: Record<string, BinaryTarget>;
    description: string;
    /** `binary`, `npx` and `uvx` entries the agent has, for the reason shown when none can be installed. */
    distributions: string[];
    id: string;
    license: string;
    name: string;
    npx?: NpxDistribution;
    publisher: string;
    repository: string;
    version: string;
}

/** What the window lists. Nothing here is acted on: an install names only `id` and `version`. */
export interface RegistryListing {
    description: string;
    id: string;
    installable: boolean;
    license: string;
    name: string;
    publisher: string;
    /** Why it cannot be installed here. */
    reason?: string;
    repository: string;
    version: string;
}

/** A download this machine can verify and unpack, resolved from one snapshot. */
export interface ResolvedInstall {
    agent: RegistryAgent;
    format: ArchiveFormat;
    kind: "binary";
    sha256: string;
    target: BinaryTarget;
}

/** An npm package pinned at an exact version. The package index's hash is looked up after this, before the consent. */
export interface ResolvedNpmInstall {
    agent: RegistryAgent;
    args: string[];
    env: Record<string, string>;
    kind: "npm";
    /** `name` or `@scope/name`. */
    name: string;
    version: string;
}

type Fetch = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const plainString = (value: unknown, max = 2000): string | undefined => typeof value === "string" && value.length <= max && !CONTROL_CHARACTER.test(value) ? value : undefined;

const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;

/** The platform key the registry uses (`darwin-aarch64`), or `undefined` where no agent can be installed. */
export const platformKey = (platform: string, arch: string): string | undefined => {
    const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
    const cpu = { arm64: "aarch64", x64: "x86_64" }[arch];

    return os !== undefined && cpu !== undefined ? `${os}-${cpu}` : undefined;
};

const safeDecode = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

/** The format of a download by its URL, or `undefined` for one this build cannot unpack. */
export const archiveFormat = (url: string): ArchiveFormat | undefined => {
    // Decoded: `%2Ezip` is a ZIP, not a bare binary.
    const path = safeDecode(new URL(url).pathname).toLowerCase();

    for (const [suffix, format] of ARCHIVE_SUFFIXES) {
        if (path.endsWith(suffix)) {
            return format;
        }
    }

    // The registry allows a bare binary; a known archive or installer type that is not handled is not one.
    return UNSUPPORTED_SUFFIXES.some((suffix) => path.endsWith(suffix)) ? undefined : "raw";
};

const parseTarget = (value: unknown): BinaryTarget | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    const archive = plainString(value.archive);
    const command = plainString(value.cmd, 500);
    const args = value.args === undefined ? [] : strings(value.args);
    const env = value.env === undefined ? {} : value.env;

    if (archive === undefined || command === undefined || args === undefined || !isRecord(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
        return undefined;
    }

    const sha256 = typeof value.sha256 === "string" && SHA256.test(value.sha256) ? value.sha256.toLowerCase() : undefined;

    return { archive, args, cmd: command, env: env as Record<string, string>, ...sha256 !== undefined && { sha256 } };
};

const parseNpx = (value: unknown): NpxDistribution | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    const spec = plainString(value.package, 300);
    const args = value.args === undefined ? [] : strings(value.args);
    const env = value.env === undefined ? {} : value.env;

    if (spec === undefined || args === undefined || !isRecord(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
        return undefined;
    }

    return { args, env: env as Record<string, string>, package: spec };
};

/** Who published it: the entry's `authors`, else the owner of its GitHub repository. */
const publisherOf = (entry: Record<string, unknown>, repo: string): string => {
    const authors = strings(entry.authors)?.filter((author) => author.trim() !== "");

    if (authors !== undefined && authors.length > 0) {
        return authors.join(", ").slice(0, 200);
    }

    return GITHUB_OWNER.exec(repo)?.[1] ?? "unknown publisher";
};

/** The agents of a registry file. An entry that does not match the schema is left out, not fatal for the rest. */
/** The `binary` distribution's targets by platform; a target that does not parse is left out. */
const parseBinaries = (value: unknown): Record<string, BinaryTarget> => {
    const binary: Record<string, BinaryTarget> = {};

    if (isRecord(value)) {
        for (const [platform, entry] of Object.entries(value)) {
            const target = parseTarget(entry);

            if (target !== undefined) {
                binary[platform] = target;
            }
        }
    }

    return binary;
};

export const parseRegistry = (json: unknown): RegistryAgent[] => {
    if (!isRecord(json) || !Array.isArray(json.agents)) {
        throw new Error("The registry answered in a format Neore does not know.");
    }

    const agents: RegistryAgent[] = [];

    for (const entry of json.agents as unknown[]) {
        if (!isRecord(entry) || !isRecord(entry.distribution)) {
            continue;
        }

        const id = plainString(entry.id, 40);
        const name = plainString(entry.name, 60);
        const version = plainString(entry.version, 40);

        if (name === undefined || version === undefined || id === undefined || !AGENT_ID.test(id)) {
            continue;
        }

        const repo = plainString(entry.repository) ?? "";
        const npx = parseNpx(entry.distribution.npx);

        agents.push({
            binary: parseBinaries(entry.distribution.binary),
            description: plainString(entry.description, 600) ?? "",
            distributions: Object.keys(entry.distribution),
            id,
            license: plainString(entry.license, 100) ?? "not stated",
            name,
            ...npx !== undefined && { npx },
            publisher: publisherOf(entry, repo),
            repository: repo,
            version,
        });
    }

    // Two entries with one id are ambiguous: an install resolves by id, so neither is offered.
    const counts = new Map<string, number>();

    for (const { id } of agents) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    return agents.filter(({ id }) => counts.get(id) === 1);
};

const badEnvName = (name: string): boolean => {
    const upper = name.toUpperCase();

    return !ENV_NAME.test(name)
        || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
        || CODE_LOADING_ENV_NAMES.has(upper)
        || CODE_LOADING_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
};

const leavesFolder = (command: string): boolean =>
    command.startsWith("/") || command.startsWith("\\") || WINDOWS_DRIVE.test(command) || command.split(PATH_SEPARATOR).includes("..");

/** Why the core would refuse the registry's own text for this entry, if it would. */
const agentUnfit = ({ name, publisher, version }: RegistryAgent): string | undefined => {
    if (!VERSION.test(version) || version.includes("..")) {
        return "The registry's version is not a plain version number.";
    }

    if (name.trim() === "" || publisher.trim() === "" || Buffer.byteLength(publisher) > MAX_PUBLISHER || CONTROL_CHARACTER.test(publisher)) {
        return "The registry's name or publisher is empty or too long.";
    }

    return undefined;
};

/** Why the core would refuse these start-up arguments or variables, if it would. */
const launchUnfit = (args: string[], env: Record<string, string>): string | undefined => {
    if (args.length > MAX_ARGS || args.some((argument) => Buffer.byteLength(argument) > MAX_ARG_BYTES || CONTROL_CHARACTER.test(argument))) {
        return "Its start-up arguments are longer than Neore accepts.";
    }

    const entries = Object.entries(env);

    if (entries.length > MAX_ENV_VARS || entries.reduce((sum, [variable, value]) => sum + Buffer.byteLength(variable) + Buffer.byteLength(value), 0) > MAX_ENV_TOTAL_BYTES) {
        return "Its start-up variables are longer than Neore accepts.";
    }

    const offender = entries.find(([variable, value]) => badEnvName(variable) || Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES || value.includes("\0"));

    return offender === undefined ? undefined : `It sets ${offender[0]}, which Neore does not allow an install to set.`;
};

/** Why the core would refuse this entry, if it would. */
const unfit = (agent: RegistryAgent, target: BinaryTarget, format: ArchiveFormat): string | undefined => {
    const problem = agentUnfit(agent);

    if (problem !== undefined) {
        return problem;
    }

    if (Buffer.byteLength(target.archive) > MAX_SOURCE) {
        return "The download address is too long.";
    }

    // A bare download is one file, so its command is that file's name.
    const nested = format === "raw" && PATH_SEPARATOR.test(target.cmd.replace(LEADING_DOT_SLASH, ""));

    const bareCommand = target.cmd.trim().replace(LEADING_DOT_SLASH, "");

    if (nested || bareCommand === "" || bareCommand === "." || leavesFolder(target.cmd) || target.cmd.includes("\0")) {
        return "The command it starts is not a file inside the download.";
    }

    return launchUnfit(target.args, target.env);
};

/** An exact version: no range, tag (`latest`) or missing version, which npm would resolve on the day it runs. */
const NPM_PACKAGE = /^((?:@[a-z\d~-][\d._a-z~-]*\/)?[a-z\d~-][\d._a-z~-]*)@(\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?)$/u;
const MAX_NPM_NAME = 214;
/** The core's version limit (`valid_version`), in bytes. */
const MAX_NPM_VERSION = 40;
/** The core adds the program's path to the arguments and allows 50 in all (`validate_agent`). */
const MAX_NPM_ARGS = 49;

/** The package of an `npx` entry pinned at its exact version, or the reason it cannot be. */
const resolveNpm = (agent: RegistryAgent, platform: string): ResolvedNpmInstall | string => {
    const { npx } = agent;

    if (npx === undefined) {
        return "This agent has no npm distribution.";
    }

    if (platform.startsWith("windows")) {
        return "Installing an npm agent is not supported on Windows yet.";
    }

    const match = NPM_PACKAGE.exec(npx.package);
    const name = match?.[1];
    const version = match?.[2];

    if (name === undefined || version === undefined || name.length > MAX_NPM_NAME || version.length > MAX_NPM_VERSION || version.includes("..")) {
        return "The registry does not name an exact version of the npm package, so Neore would not know what it installs.";
    }

    if (npx.args.length > MAX_NPM_ARGS) {
        return `It passes more than ${String(MAX_NPM_ARGS)} arguments, more than Neore will start an agent with.`;
    }

    return agentUnfit(agent) ?? launchUnfit(npx.args, npx.env) ?? { agent, args: npx.args, env: npx.env, kind: "npm", name, version };
};

/** The install for `platform`: a verified download, an npm package to pin, or the reason there is none. */
export const resolveInstall = (agent: RegistryAgent, platform: string | undefined): ResolvedInstall | ResolvedNpmInstall | string => {
    if (platform === undefined) {
        return "Installing agents is not supported on this platform.";
    }

    const target = agent.binary[platform];

    if (target === undefined || target.sha256 === undefined) {
        if (agent.npx !== undefined) {
            return resolveNpm(agent, platform);
        }

        if (target !== undefined) {
            return "The publisher lists no checksum for this download, so Neore cannot verify it.";
        }

        if (Object.keys(agent.binary).length > 0) {
            return `No download for this platform (${platform}).`;
        }

        return agent.distributions.includes("uvx")
            ? "Runs through uvx (a Python package), which Neore cannot install pinned and verified yet. Add it by hand to use it."
            : "It lists no distribution Neore can install. Add it by hand to use it.";
    }

    let url: URL;

    try {
        url = new URL(target.archive);
    } catch {
        return "The download address is not a valid URL.";
    }

    if (url.protocol !== "https:") {
        return "The download is not served over https.";
    }

    const format = archiveFormat(target.archive);

    if (format === undefined) {
        return "The download is in a format Neore cannot unpack (supported: .tar.gz, .zip, a bare binary).";
    }

    const reason = unfit(agent, target, format);

    return reason ?? { agent, format, kind: "binary", sha256: target.sha256, target };
};

export const readCapped = async (response: Response, max: number): Promise<string> => {
    if (response.body === null) {
        throw new Error("The registry sent no content.");
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    // Leaving the loop early cancels the stream.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;

        if (received > max) {
            throw new Error("The registry answer is larger than expected.");
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
};

const MAX_REDIRECTS = 5;

/**
 * Fetches `url`, following redirects by hand: every hop must be https and not a private host BEFORE it is requested, so an http
 * detour is never contacted (a check on the final URL alone would have sent the request and read the answer first).
 */
export const fetchHttps = async (fetchImpl: Fetch, url: string, init: RequestInit, onlyHost?: string): Promise<Response> => {
    let current = url;

    for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
        if (new URL(current).protocol !== "https:") {
            throw new Error("A download was redirected away from https.");
        }

        if (onlyHost !== undefined && new URL(current).host !== onlyHost) {
            throw new Error("A download was redirected away from the address it was confirmed for.");
        }

        if (isPrivateHost(new URL(current).hostname)) {
            throw new Error("A download points at this computer or a private network.");
        }

        // eslint-disable-next-line no-await-in-loop -- each hop depends on the previous answer
        const response = await fetchImpl(current, { ...init, redirect: "manual" });

        if (response.status < 300 || response.status >= 400) {
            return response;
        }

        const location = response.headers.get("location");

        // eslint-disable-next-line no-await-in-loop -- the redirect body is dropped before the next hop
        await response.body?.cancel();

        if (location === null) {
            throw new Error("A download was redirected with no destination.");
        }

        current = new URL(location, current).href;
    }

    throw new Error("A download was redirected too many times.");
};

export interface RegistryOptions {
    arch?: string;
    fetch?: Fetch;
    /** Whether node and npm are here; without them an npm agent is listed with the reason instead of an Install button. */
    hasNpmTools?: () => boolean;
    now?: () => number;
    platform?: string;
    /** False where coding agents cannot run (`acpSupported`): everything is listed, nothing is installable. */
    supported?: boolean;
}

/**
 * Reads the registry when a search asks and keeps the answer in memory, so the entry the user sees is the one
 * installed. It starts no timer and checks nothing on its own: an installed agent is never compared with the
 * registry, so there is no update path to disable.
 */
export class AgentRegistry {
    private snapshot?: { agents: RegistryAgent[]; at: number };

    private readonly fetchImpl: Fetch;

    private readonly hasNpmTools: () => boolean;

    private readonly now: () => number;

    private readonly platform: string | undefined;

    public constructor(options: RegistryOptions = {}) {
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.hasNpmTools = options.hasNpmTools ?? (() => true);
        this.platform = options.supported === false ? undefined : platformKey(options.platform ?? process.platform, options.arch ?? process.arch);
    }

    /** Lists the agents matching `query` (all of them when empty), from an answer under a minute old or a new fetch. */
    public async search(query: string): Promise<RegistryListing[]> {
        const { snapshot } = this;
        const agents = snapshot !== undefined && this.now() - snapshot.at < SNAPSHOT_REUSE_MS ? snapshot.agents : await this.load();
        const needle = query.trim().toLowerCase();

        return agents
            .filter((agent) => needle === "" || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(needle)))
            .slice(0, MAX_RESULTS)
            .map((agent) => this.listing(agent));
    }

    /** The download for `id` at exactly `version`, from the last search. Anything else asks for a new search. */
    public resolve(id: string, version: string): ResolvedInstall | ResolvedNpmInstall {
        if (this.snapshot === undefined || this.now() - this.snapshot.at > SNAPSHOT_MAX_AGE_MS) {
            throw new Error("Search the registry again before installing.");
        }

        const agent = this.snapshot.agents.find((candidate) => candidate.id === id);

        if (agent === undefined || agent.version !== version) {
            throw new Error("That version is not what the registry lists now. Search again.");
        }

        const resolved = resolveInstall(agent, this.platform);

        if (typeof resolved === "string") {
            throw new TypeError(resolved);
        }

        return resolved;
    }

    private async load(): Promise<RegistryAgent[]> {
        const response = await fetchHttps(this.fetchImpl, REGISTRY_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });

        if (!response.ok) {
            await response.body?.cancel();

            throw new Error(`The registry answered ${String(response.status)}.`);
        }

        const agents = parseRegistry(JSON.parse(await readCapped(response, MAX_REGISTRY_BYTES)) as unknown);

        this.snapshot = { agents, at: this.now() };

        return agents;
    }

    private listing(agent: RegistryAgent): RegistryListing {
        const found = resolveInstall(agent, this.platform);
        const resolved = typeof found !== "string" && found.kind === "npm" && !this.hasNpmTools() ? "Node.js and npm were not found. Install Node.js (which includes npm), then search again." : found;

        return {
            description: agent.description,
            id: agent.id,
            installable: typeof resolved !== "string",
            license: agent.license,
            name: agent.name,
            publisher: agent.publisher,
            ...(typeof resolved === "string") && { reason: resolved },
            repository: agent.repository,
            version: agent.version,
        };
    }
}
