/**
 * The official ACP agent registry, read by the desktop main process (never the page, never the backend, which
 * would learn what the user installs): a JSON file on the protocol's CDN listing agents and, for some, the
 * archives to download. Documented at https://agentclientprotocol.com/get-started/registry; the entry format is
 * `agent.schema.json` in the `agentclientprotocol/registry` repository.
 *
 * An agent is installable here only when it has a `binary` download for this platform WITH a published SHA-256:
 * without a checksum nothing can show the file is the one the publisher released, and an `npx`/`uvx` entry would
 * fetch whatever the package manager resolves at launch. Those are listed, with the reason, and not installable.
 */

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const REGISTRY_TIMEOUT_MS = 15_000;
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
/** A search result older than this is not installed from: the user searches again and sees what is current. */
const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
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

export interface RegistryAgent {
    binary: Record<string, BinaryTarget>;
    description: string;
    /** `binary`, `npx` and `uvx` entries the agent has, for the reason shown when none can be installed. */
    distributions: string[];
    id: string;
    license: string;
    name: string;
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
    sha256: string;
    target: BinaryTarget;
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

/** The format of a download by its URL, or `undefined` for one this build cannot unpack. */
export const archiveFormat = (url: string): ArchiveFormat | undefined => {
    const path = new URL(url).pathname.toLowerCase();

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

/** Who published it: the entry's `authors`, else the owner of its GitHub repository. */
const publisherOf = (entry: Record<string, unknown>, repo: string): string => {
    const authors = strings(entry.authors)?.filter((author) => author.trim() !== "");

    if (authors !== undefined && authors.length > 0) {
        return authors.join(", ").slice(0, 200);
    }

    return GITHUB_OWNER.exec(repo)?.[1] ?? "unknown publisher";
};

/** The agents of a registry file. An entry that does not match the schema is left out, not fatal for the rest. */
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
        const binary: Record<string, BinaryTarget> = {};

        if (isRecord(entry.distribution.binary)) {
            for (const [platform, value] of Object.entries(entry.distribution.binary)) {
                const target = parseTarget(value);

                if (target !== undefined) {
                    binary[platform] = target;
                }
            }
        }

        agents.push({
            binary,
            description: plainString(entry.description, 600) ?? "",
            distributions: Object.keys(entry.distribution),
            id,
            license: plainString(entry.license, 100) ?? "not stated",
            name,
            publisher: publisherOf(entry, repo),
            repository: repo,
            version,
        });
    }

    return agents;
};

/** The download for `platform`, or the reason there is none. */
export const resolveInstall = (agent: RegistryAgent, platform: string | undefined): ResolvedInstall | string => {
    if (platform === undefined) {
        return "Installing agents is not supported on this platform.";
    }

    const target = agent.binary[platform];

    if (target === undefined) {
        return Object.keys(agent.binary).length > 0
            ? `No download for this platform (${platform}).`
            : "Runs through npx or uvx, which would fetch unverified code each time. Add it by hand to use it.";
    }

    if (target.sha256 === undefined) {
        return "The publisher lists no checksum for this download, so Neore cannot verify it.";
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

    return { agent, format, sha256: target.sha256, target };
};

const readCapped = async (response: Response, max: number): Promise<string> => {
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

/** `https:` after redirects: a transport the registry did not name is not followed. */
export const assertHttps = (response: Response, requested: string): void => {
    if (new URL(response.url === "" ? requested : response.url).protocol !== "https:") {
        throw new Error("A download was redirected away from https.");
    }
};

export interface RegistryOptions {
    arch?: string;
    fetch?: Fetch;
    now?: () => number;
    platform?: string;
}

/**
 * Reads the registry when a search asks and keeps the answer in memory, so the entry the user sees is the one
 * installed. It starts no timer and checks nothing on its own: an installed agent is never compared with the
 * registry, so there is no update path to disable.
 */
export class AgentRegistry {
    private snapshot?: { agents: RegistryAgent[]; at: number };

    private readonly fetchImpl: Fetch;

    private readonly now: () => number;

    private readonly platform: string | undefined;

    public constructor(options: RegistryOptions = {}) {
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.platform = platformKey(options.platform ?? process.platform, options.arch ?? process.arch);
    }

    /** Fetches the registry again and lists the agents matching `query` (all of them when empty). */
    public async search(query: string): Promise<RegistryListing[]> {
        const response = await this.fetchImpl(REGISTRY_URL, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });

        if (!response.ok) {
            await response.body?.cancel();

            throw new Error(`The registry answered ${String(response.status)}.`);
        }

        assertHttps(response, REGISTRY_URL);

        const agents = parseRegistry(JSON.parse(await readCapped(response, MAX_REGISTRY_BYTES)) as unknown);

        this.snapshot = { agents, at: this.now() };

        const needle = query.trim().toLowerCase();

        return agents
            .filter((agent) => needle === "" || [agent.id, agent.name, agent.description].some((field) => field.toLowerCase().includes(needle)))
            .slice(0, MAX_RESULTS)
            .map((agent) => {
                const resolved = resolveInstall(agent, this.platform);

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
            });
    }

    /** The download for `id` at exactly `version`, from the last search. Anything else asks for a new search. */
    public resolve(id: string, version: string): ResolvedInstall {
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
}
