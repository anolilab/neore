/**
 * Client + normaliser for the official MCP Registry
 * (https://registry.modelcontextprotocol.io, API `v0.1`).
 *
 * The registry lists every published server, most of which only ship a local
 * package (`npx`, `uvx`, docker) run over stdio. We connect from a Worker, so
 * only servers declaring a REMOTE transport — `streamable-http` or `sse` — are
 * usable; everything else is filtered out here rather than shown and failing
 * on connect.
 *
 * The normaliser is deliberately forgiving: the registry's schema has already
 * changed revision several times (`$schema` 2025-09-16 → 2025-12-11 is visible
 * in one page of results), so an unexpected field shape drops that ONE entry or
 * field instead of failing the whole listing.
 */
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";

export const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

/** The registry rejects `limit` above 100. */
const REGISTRY_PAGE_LIMIT = 50;

/**
 * Registry pages are filtered down to remote servers, which can leave a page
 * nearly empty (roughly a quarter of entries are stdio-only). Keep fetching until
 * this many usable entries are collected — bounded by {@link MAX_REGISTRY_ROUNDS}
 * so a run of stdio-only pages cannot turn one call into an unbounded crawl.
 */
const MIN_ENTRIES_PER_PAGE = 20;

const MAX_REGISTRY_ROUNDS = 3;

/** Longest search string forwarded to the registry. */
export const MAX_REGISTRY_SEARCH_LENGTH = 100;

export type McpRegistryProtocol = "http" | "sse";

/** A header or URL variable the user must (or may) supply before connecting. */
export interface McpRegistryInput {
    choices?: string[];
    description?: string;
    isRequired: boolean;
    isSecret: boolean;
    name: string;
    placeholder?: string;
    /** A default, or for headers a template such as `Bearer {api_key}`. */
    value?: string;
}

export interface McpRegistryRemote {
    headers: McpRegistryInput[];
    protocol: McpRegistryProtocol;
    /** May contain `{variable}` placeholders, described by `variables`. */
    url: string;
    variables: McpRegistryInput[];
}

export interface McpRegistryServer {
    description: string;
    icon?: string;
    /** The registry's reverse-DNS server name, e.g. `io.github.owner/server`. Unique. */
    id: string;
    remotes: McpRegistryRemote[];
    repositoryUrl?: string;
    title: string;
    version: string;
    websiteUrl?: string;
}

export interface McpRegistryPage {
    nextCursor?: string;
    servers: McpRegistryServer[];
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** Only `https:` URLs are accepted — for remotes, icons and links alike. */
const httpsUrl = (value: unknown): string | undefined => {
    const text = optionalString(value);

    if (!text) {
        return undefined;
    }

    // Templated remote URLs (`https://{host}/mcp`) do not parse, so check the
    // scheme textually and leave host validation to the connection test.
    return text.toLowerCase().startsWith("https://") ? text : undefined;
};

const TRANSPORTS: Record<string, McpRegistryProtocol> = {
    sse: "sse",
    "streamable-http": "http",
};

const normaliseInput = (raw: unknown, fallbackName?: string): McpRegistryInput | undefined => {
    if (!isRecord(raw)) {
        return undefined;
    }

    const name = optionalString(raw.name) ?? fallbackName;

    if (!name) {
        return undefined;
    }

    const choices = Array.isArray(raw.choices) ? raw.choices.filter((choice): choice is string => typeof choice === "string" && choice !== "") : [];

    const input: McpRegistryInput = {
        isRequired: raw.isRequired === true,
        isSecret: raw.isSecret === true,
        name,
    };

    const description = optionalString(raw.description);
    const placeholder = optionalString(raw.placeholder);
    const value = optionalString(raw.value) ?? optionalString(raw.default);

    if (description) {
        input.description = description;
    }

    if (placeholder) {
        input.placeholder = placeholder;
    }

    if (value) {
        input.value = value;
    }

    if (choices.length > 0) {
        input.choices = choices;
    }

    return input;
};

const normaliseRemote = (raw: unknown): McpRegistryRemote | undefined => {
    if (!isRecord(raw) || typeof raw.type !== "string") {
        return undefined;
    }

    const protocol = TRANSPORTS[raw.type];
    const url = httpsUrl(raw.url);

    if (!protocol || !url) {
        return undefined;
    }

    const headers = (Array.isArray(raw.headers) ? raw.headers : [])
        .map((header) => normaliseInput(header))
        .filter((header): header is McpRegistryInput => header !== undefined);

    // `variables` is an object keyed by variable name, not an array.
    const variables = isRecord(raw.variables)
        ? Object.entries(raw.variables)
              .map(([name, variable]) => normaliseInput(variable, name))
              .filter((variable): variable is McpRegistryInput => variable !== undefined)
        : [];

    return { headers, protocol, url, variables };
};

/** `io.github.owner/my-server` → `my-server`, when the entry carries no `title`. */
const titleFromName = (name: string): string => name.slice(name.lastIndexOf("/") + 1) || name;

const pickIcon = (icons: unknown): string | undefined => {
    if (!Array.isArray(icons)) {
        return undefined;
    }

    for (const icon of icons) {
        const source = isRecord(icon) ? httpsUrl(icon.src) : undefined;

        if (source) {
            return source;
        }
    }

    return undefined;
};

const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

/**
 * Map one registry list entry (`{ server, _meta }`) to our shape, or `undefined`
 * when it is unusable: not active, malformed, or offering no remote transport.
 */
export const normaliseRegistryEntry = (entry: unknown): McpRegistryServer | undefined => {
    if (!isRecord(entry) || !isRecord(entry.server)) {
        return undefined;
    }

    const { server } = entry;
    const official = isRecord(entry._meta) ? entry._meta[OFFICIAL_META_KEY] : undefined;

    // `deprecated` / `deleted` entries are still listed; a missing status is
    // treated as active so a registry that drops the meta block keeps working.
    if (isRecord(official) && typeof official.status === "string" && official.status !== "active") {
        return undefined;
    }

    const id = optionalString(server.name);

    if (!id) {
        return undefined;
    }

    const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
        .map((remote) => normaliseRemote(remote))
        .filter((remote): remote is McpRegistryRemote => remote !== undefined);

    if (remotes.length === 0) {
        return undefined;
    }

    const result: McpRegistryServer = {
        description: optionalString(server.description) ?? "",
        id,
        remotes,
        title: optionalString(server.title) ?? titleFromName(id),
        version: optionalString(server.version) ?? "",
    };

    const icon = pickIcon(server.icons);
    const websiteUrl = httpsUrl(server.websiteUrl);
    const repoUrl = isRecord(server.repository) ? httpsUrl(server.repository.url) : undefined;

    if (icon) {
        result.icon = icon;
    }

    if (websiteUrl) {
        result.websiteUrl = websiteUrl;
    }

    if (repoUrl) {
        result.repositoryUrl = repoUrl;
    }

    return result;
};

/** Normalise a whole `GET /v0.1/servers` response body. */
export const normaliseRegistryResponse = (body: unknown): McpRegistryPage => {
    if (!isRecord(body) || !Array.isArray(body.servers)) {
        throw new TypeError("MCP registry: response has no `servers` array");
    }

    const seen = new Set<string>();
    const servers: McpRegistryServer[] = [];

    for (const entry of body.servers) {
        const server = normaliseRegistryEntry(entry);

        // `version=latest` should already make names unique; dedupe anyway so a
        // registry-side regression cannot produce duplicate React keys.
        if (server && !seen.has(server.id)) {
            seen.add(server.id);
            servers.push(server);
        }
    }

    const nextCursor = isRecord(body.metadata) ? optionalString(body.metadata.nextCursor) : undefined;

    return nextCursor ? { nextCursor, servers } : { servers };
};

export const buildRegistryUrl = (options: { cursor?: string; limit?: number; search?: string }): string => {
    const url = new URL(MCP_REGISTRY_BASE_URL);

    url.searchParams.set("limit", String(options.limit ?? REGISTRY_PAGE_LIMIT));
    url.searchParams.set("version", "latest");

    if (options.cursor) {
        url.searchParams.set("cursor", options.cursor);
    }

    const search = options.search?.trim().slice(0, MAX_REGISTRY_SEARCH_LENGTH);

    if (search) {
        url.searchParams.set("search", search);
    }

    return url.href;
};

/**
 * Fetch one page of remote-capable servers, following registry cursors until
 * enough usable entries are collected. Throws on any failure — the caller decides
 * what "unavailable" means, and a thrown error is also what keeps a failure out
 * of the action cache.
 */
export const fetchRegistryPage = async (
    options: { cursor?: string; search?: string },
    fetchImpl: typeof fetchWithDeadline = fetchWithDeadline,
): Promise<McpRegistryPage> => {
    const servers: McpRegistryServer[] = [];
    const seen = new Set<string>();
    let { cursor } = options;

    for (let round = 0; round < MAX_REGISTRY_ROUNDS; round += 1) {
        const response = await fetchImpl(buildRegistryUrl({ cursor, search: options.search }), {
            headers: { accept: "application/json" },
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        if (!response.ok) {
            // A Worker must consume or cancel every body it opens — an abandoned
            // one is what escalates to `Network connection lost.` in local dev.
            await response.body?.cancel();

            throw new Error(`MCP registry responded ${String(response.status)}`);
        }

        const page = normaliseRegistryResponse(await response.json());

        for (const server of page.servers) {
            if (seen.has(server.id)) {
                continue;
            }

            seen.add(server.id);
            servers.push(server);
        }

        cursor = page.nextCursor;

        if (!cursor || servers.length >= MIN_ENTRIES_PER_PAGE) {
            break;
        }
    }

    return cursor ? { nextCursor: cursor, servers } : { servers };
};
