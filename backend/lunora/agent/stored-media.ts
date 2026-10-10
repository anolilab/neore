/**
 * Fresh signed URLs for the stored objects a message mentions — minted when
 * the message is READ (for a model call, for display), never persisted.
 *
 * Messages persist `storage:<key>` references (`lib/storage-ref.ts`); rows from
 * before that carry URLs this deployment issued, whose key is in the path. Both
 * are rewritten here, in two places:
 *
 * - `image` / `file` parts — the attachment itself;
 * - `tool-result` outputs — tools report generated media as a URL;
 * - nowhere else. TEXT is never rewritten: a user can type any string, and a
 *   reference they typed must not become a working link to someone else's file.
 *
 * For the same reason a USER message's image/file part is only signed when its
 * key belongs to a file attached to that message (`fileIds`, each checked for
 * ownership when the message was saved — `agent_files.getFileForUser`). A part
 * that names storage it has no claim to is replaced by a text placeholder
 * rather than passed on.
 *
 * A TOOL RESULT is server-produced but not server-controlled: its output
 * carries whatever the tool returned — a fetched page, an MCP server's reply —
 * and a `storage:` reference or a URL to our storage in there is signed only
 * when the MESSAGE'S OWNER owns that key (`lib/storage-ownership.ts`, the
 * same rule as workflow data). Anything else becomes
 * {@link UNAVAILABLE_TOOL_STORAGE_URL}.
 */
import { storageKeyOf } from "../lib/storage-ref";
import { collectStrings, isRecord, mapStrings } from "../lib/storage-sign";

type Json = boolean | number | string | null | Json[] | { [key: string]: Json };

export interface MediaMessage {
    content: unknown;
    role: string;
}

export interface ResolveMediaOptions {
    /** Keys of the files attached to this message; gates user-message parts. */
    allowedKeys: ReadonlySet<string>;
    /** The bases URLs were issued under (`issuedStorageOrigins()`). */
    origins: ReadonlyArray<string>;
    /** Mint a signed GET URL for a key. Called once per distinct key. */
    sign: (key: string) => Promise<string>;
    /** Keys the message's owner owns; gates storage named inside tool-result outputs. */
    toolKeys: ReadonlySet<string>;
}

export const UNAVAILABLE_ATTACHMENT_TEXT = "[attachment unavailable]";

/** What a tool-result string naming storage its owner does not own becomes. */
export const UNAVAILABLE_TOOL_STORAGE_URL = "";

/** The field of a part that holds the object: `image` on image parts, `data` on file parts. */
const mediaField = (part: Record<string, unknown>): "data" | "image" | null => {
    if (part["type"] === "image") {
        return "image";
    }

    if (part["type"] === "file") {
        return "data";
    }

    return null;
};

/**
 * `message` with every stored-object mention re-signed. Content that mentions
 * none comes back unchanged (same reference), so callers can skip copying.
 */
export const resolveStoredMedia = async <M extends MediaMessage>(message: M, options: ResolveMediaOptions): Promise<M> => {
    if (!Array.isArray(message.content)) {
        return message;
    }

    const isUser = message.role === "user";
    const wanted = new Set<string>();
    let hasForeignToolStorage = false;
    const keyOf = (value: unknown): string | null => storageKeyOf(value, options.origins);

    for (const part of message.content as unknown[]) {
        if (!isRecord(part)) {
            continue;
        }

        const field = mediaField(part);
        const key = field ? keyOf(part[field]) : null;

        if (key && (!isUser || options.allowedKeys.has(key))) {
            wanted.add(key);
        }

        if (part["type"] === "tool-result" && !isUser) {
            const outputStrings = collectStrings(part["output"]);

            for (const text of outputStrings) {
                const toolKey = keyOf(text);

                if (toolKey && options.toolKeys.has(toolKey)) {
                    wanted.add(toolKey);
                } else if (toolKey) {
                    hasForeignToolStorage = true;
                }
            }
        }
    }

    const hasForeignUserMedia =
        isUser &&
        (message.content as unknown[]).some((part) => {
            if (!isRecord(part)) {
                return false;
            }

            const field = mediaField(part);
            const key = field ? keyOf(part[field]) : null;

            return key !== null && !options.allowedKeys.has(key);
        });

    if (wanted.size === 0 && !hasForeignUserMedia && !hasForeignToolStorage) {
        return message;
    }

    const signed = new Map<string, string>();

    await Promise.all(
        [...wanted].map(async (key) => {
            signed.set(key, await options.sign(key));
        }),
    );

    const content = (message.content as unknown[]).map((part) => {
        if (!isRecord(part)) {
            return part;
        }

        const field = mediaField(part);

        if (field) {
            const key = keyOf(part[field]);

            if (!key) {
                return part;
            }

            const url = signed.get(key);

            return url ? { ...part, [field]: url } : { text: UNAVAILABLE_ATTACHMENT_TEXT, type: "text" };
        }

        if (part["type"] === "tool-result" && !isUser) {
            return {
                ...part,
                output: mapStrings(part["output"], (text) => {
                    const key = keyOf(text);

                    if (!key) {
                        return text;
                    }

                    return options.toolKeys.has(key) ? (signed.get(key) ?? text) : UNAVAILABLE_TOOL_STORAGE_URL;
                }) as Json,
            };
        }

        return part;
    });

    return { ...message, content };
};

export interface MediaDoc {
    fileIds?: ReadonlyArray<string>;
    message?: MediaMessage;
    /** The message's owner: whose storage its tool results may name. */
    userId?: string;
}

/** Every storage key named inside a message's tool-result outputs. */
export const toolResultStorageKeys = (message: MediaMessage | undefined, origins: ReadonlyArray<string>): string[] => {
    if (!message || message.role === "user" || !Array.isArray(message.content)) {
        return [];
    }

    return (message.content as unknown[])
        .filter((part): part is Record<string, unknown> => isRecord(part) && part["type"] === "tool-result")
        .flatMap((part) => collectStrings(part["output"]))
        .map((text) => storageKeyOf(text, origins))
        .filter((key): key is string => key !== null);
};

/**
 * Re-sign every doc's message. `lookupKeys` maps the docs' file ids to storage
 * keys in one batch (a query reads `chatFiles` directly; an action goes
 * through `agent_files.getStorageKeys`). `lookupOwnedKeys` answers which of
 * the keys a doc's tool results name its owner owns — once per owner (a query
 * calls `ownedStorageKeys`; an action `agent_files.getOwnedStorageKeys`).
 */
export const resolveDocsStoredMedia = async <D extends MediaDoc>(
    docs: ReadonlyArray<D>,
    options: {
        lookupKeys: (fileIds: string[]) => Promise<Map<string, string>>;
        lookupOwnedKeys: (userId: string, keys: string[]) => Promise<ReadonlySet<string>>;
        origins: ReadonlyArray<string>;
        sign: (key: string) => Promise<string>;
    },
): Promise<D[]> => {
    const fileIds = [...new Set(docs.flatMap((doc) => doc.fileIds ?? []))];
    const keysByFile = fileIds.length > 0 ? await options.lookupKeys(fileIds) : new Map<string, string>();
    const toolKeysByOwner = new Map<string, Set<string>>();

    for (const doc of docs) {
        const keys = toolResultStorageKeys(doc.message, options.origins);

        if (doc.userId && keys.length > 0) {
            const pending = toolKeysByOwner.get(doc.userId) ?? new Set<string>();

            keys.forEach((key) => pending.add(key));
            toolKeysByOwner.set(doc.userId, pending);
        }
    }

    const ownedByOwner = new Map(
        await Promise.all([...toolKeysByOwner].map(async ([userId, keys]) => [userId, await options.lookupOwnedKeys(userId, [...keys])] as const)),
    );
    const noKeys: ReadonlySet<string> = new Set();
    const cache = new Map<string, Promise<string>>();
    const sign = async (key: string): Promise<string> => {
        let pending = cache.get(key);

        if (!pending) {
            pending = options.sign(key);
            cache.set(key, pending);
        }

        return await pending;
    };

    return await Promise.all(
        docs.map(async (doc) => {
            if (!doc.message) {
                return doc;
            }

            const allowedKeys = new Set((doc.fileIds ?? []).map((fileId) => keysByFile.get(fileId)).filter((key): key is string => Boolean(key)));
            // A doc with no owner owns nothing: its tool results sign no storage.
            const toolKeys = (doc.userId && ownedByOwner.get(doc.userId)) || noKeys;
            const message = await resolveStoredMedia(doc.message, { allowedKeys, origins: options.origins, sign, toolKeys });

            return message === doc.message ? doc : { ...doc, message };
        }),
    );
};
