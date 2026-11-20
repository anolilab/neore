/**
 * A bot's tool selectors — the pure rules, shared with the web app (`@neore/backend/bots/tool-selectors`). A selector names
 * a built-in tool by its name, a server's tool as `<server key>:<tool>`, and every tool of a server as `<server key>:*`.
 *
 * The server key is the server's stable identity, never its display name, so renaming a server or a device keeps its
 * selectors matching: `mcp=<encoded url>` for a server the user added, `connector=<slug>` for a connector, and
 * `device=<id>` for a paired computer. A key holds no colon, so a selector splits at its FIRST colon and a tool name may
 * hold one.
 */

/** At most this many selectors in each list. */
export const BOT_TOOL_SELECTOR_MAX_COUNT = 100;

/** The longest address a user can save for a server (`MAX_LENGTH.url` in `lib/validators.ts`). */
const SERVER_URL_MAX_LENGTH = 8192;

/** The longest tool name a selector holds after its server key. */
const SELECTOR_TOOL_MAX_LENGTH = 256;

/**
 * At most this many characters in one selector: a server key carries the server's encoded address, and encoding turns one
 * character into at most nine (three UTF-8 bytes, `%XX` each), so a server at the longest address a user can save is still
 * selectable.
 */
export const BOT_TOOL_SELECTOR_MAX_LENGTH = "mcp=".length + 9 * SERVER_URL_MAX_LENGTH + 1 + SELECTOR_TOOL_MAX_LENGTH;

/** At most this many characters in all of one list's selectors together, so a few long addresses cannot grow a bot without bound. */
export const BOT_TOOL_SELECTION_MAX_LIST_CHARS = 131_072;

/**
 * Stored on the bot; absent = every tool the run would get anyway. `allow` absent = every tool, present = only the
 * tools it names (an empty list = none). `exclude` removes tools and always wins over `allow`.
 */
export interface BotToolSelection {
    allow?: string[];
    exclude: string[];
}

/** Where a tool in a run's set came from: its server's key (`mcpServerKey`, …) and its own tool name. */
export interface ToolOrigin {
    server: string;
    tool: string;
}

/** `encodeURIComponent`, or `undefined` for text it cannot encode (a lone surrogate): such a server has no key. */
const encodePart = (text: string): string | undefined => {
    try {
        return encodeURIComponent(text);
    } catch {
        return undefined;
    }
};

const keyOf = (kind: string, id: string): string | undefined => {
    const encoded = encodePart(id);

    return encoded === undefined || encoded === "" ? undefined : `${kind}=${encoded}`;
};

/** The key of a server the user added: its address, which a rename keeps. */
export const mcpServerKey = (url: string): string | undefined => keyOf("mcp", url);

/** The key of a connector: its slug. */
export const connectorServerKey = (slug: string): string | undefined => keyOf("connector", slug);

/** The key of a paired computer: its id. */
export const deviceServerKey = (deviceId: string): string | undefined => keyOf("device", deviceId);

/** A server tool's key, from what a run or the app proxy knows of its server: a connector's slug, else the address. */
export const serverKeyOf = (server: { connectorSlug?: string; url?: string }): string | undefined => {
    if (server.connectorSlug !== undefined) {
        return connectorServerKey(server.connectorSlug);
    }

    return server.url === undefined ? undefined : mcpServerKey(server.url);
};

/**
 * The key a server's tools are matched by under a selection, or `""` (none of its tools kept) when its key cannot stand for
 * it alone. For a server the user added (`savedUrls`: the addresses of every server they saved, enabled or not):
 * - the allow list names its key and another saved server shares its address, so the key would let the other one in too
 *   (an exclusion of the key removes both, which is the safe direction, so it keeps the key);
 * - an exclusion names a user server's key the bot's owner no longer has: an address was edited, and which server the
 *   exclusion meant cannot be told. In the owner's own run (`owner.runs`) no user server is trusted to be outside it. In a
 *   collaborator's run (whose servers are the collaborator's own) only a server the owner also saved can be the edited one
 *   (`owner.serverKeys`), so only such a server keeps none of its tools; the collaborator's other servers keep theirs.
 */
export const selectionServerKey = (
    selection: BotToolSelection | null | undefined,
    server: { connectorSlug?: string; url?: string },
    savedUrls: ReadonlyArray<string>,
    owner: { runs: boolean; serverKeys: ReadonlyArray<string> },
): string => {
    const key = serverKeyOf(server);

    if (key === undefined) {
        return "";
    }

    if (!selection || server.connectorSlug !== undefined) {
        return key;
    }

    const savedKeys = savedUrls.flatMap((url) => mcpServerKey(url) ?? []);
    const allowsKey = selection.allow?.some((selector) => parseServerSelector(selector)?.server === key) === true;
    const shared = allowsKey && savedKeys.filter((saved) => saved === key).length > 1;
    // The owner's own run judges by the servers it read itself; a collaborator's by the owner's, read with the bot.
    const ownerKeys = owner.runs ? savedKeys : owner.serverKeys;
    const stale = selection.exclude.some((selector) => {
        const named = parseServerSelector(selector)?.server;

        return named?.startsWith("mcp=") === true && !ownerKeys.includes(named);
    });

    return shared || (stale && (owner.runs || ownerKeys.includes(key))) ? "" : key;
};

const SERVER_KEY = /^(?:mcp|connector|device)=[^\s:]+$/u;

// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL_CHARACTERS = /[\u{0}-\u{1F}\u{7F}]/u;

/** A selector's server key and tool, or `undefined` for a built-in's name. */
export const parseServerSelector = (selector: string): ToolOrigin | undefined => {
    const colon = selector.indexOf(":");

    return colon === -1 ? undefined : { server: selector.slice(0, colon), tool: selector.slice(colon + 1) };
};

const isValidSelector = (selector: string): boolean => {
    if (selector.length > BOT_TOOL_SELECTOR_MAX_LENGTH || CONTROL_CHARACTERS.test(selector)) {
        return false;
    }

    const parsed = parseServerSelector(selector);

    // A server selector must name a server by its key: a display name would stop matching on a rename.
    return parsed === undefined || (SERVER_KEY.test(parsed.server) && parsed.tool !== "");
};

const normalizeList = (list: ReadonlyArray<string>, builtIns: ReadonlySet<string> | undefined): { error: string } | { selectors: string[] } => {
    const selectors = [...new Set(list.map((selector) => selector.trim()).filter(Boolean))];

    if (selectors.length > BOT_TOOL_SELECTOR_MAX_COUNT) {
        return { error: `A bot's tool list can name at most ${String(BOT_TOOL_SELECTOR_MAX_COUNT)} tools.` };
    }

    if (selectors.reduce((total, selector) => total + selector.length, 0) > BOT_TOOL_SELECTION_MAX_LIST_CHARS) {
        return { error: "A bot's tool list is too long: remove a server with a long address." };
    }

    const invalid = selectors.find((selector) => !isValidSelector(selector));

    if (invalid !== undefined) {
        return { error: `Invalid tool selector: ${invalid.slice(0, 64)}` };
    }

    const unknown = builtIns && selectors.find((selector) => parseServerSelector(selector) === undefined && !builtIns.has(selector));

    return unknown ? { error: `No built-in tool is named ${unknown.slice(0, 64)}` } : { selectors };
};

/**
 * The selection as stored: trimmed and de-duplicated, within the caps; one that removes nothing is no selection (`null`).
 * With `builtIns` (every built-in tool's name), a built-in selector must name one: a mistyped exclusion would remove nothing.
 */
export const normalizeBotToolSelection = (
    selection: BotToolSelection,
    builtIns?: ReadonlySet<string>,
): { error: string } | { selection: BotToolSelection | null } => {
    const exclude = normalizeList(selection.exclude, builtIns);

    if ("error" in exclude) {
        return exclude;
    }

    if (selection.allow === undefined) {
        return { selection: exclude.selectors.length > 0 ? { exclude: exclude.selectors } : null };
    }

    const allow = normalizeList(selection.allow, builtIns);

    return "error" in allow ? allow : { selection: { allow: allow.selectors, exclude: exclude.selectors } };
};

/**
 * Whether a selector names a tool: a built-in by its exact name, a server tool by its server's key and its own name (or
 * `*`). Compared whole, never parsed, so a colon in a tool name cannot shift the split. A name that matches nothing
 * selects nothing.
 */
export const selectorMatches = (selector: string, name: string, origin: ToolOrigin | undefined): boolean =>
    origin === undefined ? selector === name : selector === `${origin.server}:*` || selector === `${origin.server}:${origin.tool}`;

/**
 * Whether a selection keeps one tool: absent keeps everything; otherwise allowed (or no allow list) and not excluded. A
 * server tool whose server has no key (`origin.server === ""`) cannot be told apart from an excluded one, so it is not kept.
 */
export const selectionKeeps = (selection: BotToolSelection | null | undefined, name: string, origin: ToolOrigin | undefined): boolean => {
    if (!selection) {
        return true;
    }

    if (origin?.server === "") {
        return false;
    }

    const selects = (list: ReadonlyArray<string>): boolean => list.some((selector) => selectorMatches(selector, name, origin));

    return (selection.allow === undefined || selects(selection.allow)) && !selects(selection.exclude);
};

/**
 * Whether any tool of a server could be kept: false when the allow list names none of its tools, or the server is excluded
 * whole. A run does not connect to a server none of whose tools it could keep.
 */
export const selectionMayKeepServer = (selection: BotToolSelection | null | undefined, serverKey: string | undefined): boolean => {
    if (!selection) {
        return true;
    }

    if (serverKey === undefined || selection.exclude.includes(`${serverKey}:*`)) {
        return false;
    }

    return selection.allow === undefined || selection.allow.some((selector) => parseServerSelector(selector)?.server === serverKey);
};

/** Whether any device tool could be kept: an allow list must name one (`device=…`). */
export const selectionMayKeepDevices = (selection: BotToolSelection | null | undefined): boolean =>
    !selection || selection.allow === undefined || selection.allow.some((selector) => parseServerSelector(selector)?.server.startsWith("device=") === true);

/** What a run reads when the bot's selection cannot be read: no tools, so a failed read never widens a bot's set. */
export const NO_TOOLS_SELECTION: BotToolSelection = { allow: [], exclude: [] };
