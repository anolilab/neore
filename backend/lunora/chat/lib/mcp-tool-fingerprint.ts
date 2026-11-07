/**
 * What an MCP tool was when a run offered it to the model: a hash of where it came from, its name, its input schema and
 * its annotations. A run that pauses for an approval records one per MCP tool in its snapshot, and the continuation
 * compares them with what the server lists now. A call the model wrote, and a person approved, for a tool that has since
 * changed or gone is not executed (`resumeApprovedRun`): the model is told instead, and a fresh call asks again.
 *
 * Only the hash is stored, never the schema.
 */
import { asSchema, type ToolSet } from "ai";

import type { ToolAnnotationHints } from "./tool-permissions";

/** Hex characters kept of the SHA-256: 128 bits, ample to tell two versions of one tool apart. */
const FINGERPRINT_HEX_LENGTH = 32;

/** Code-unit order, which unlike `localeCompare` is the same in every runtime and locale. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/**
 * Schema keywords whose list is a set (`required` names, `enum` values, the members of a `type` union): a server that
 * writes one from an unordered collection would otherwise hash differently on every listing.
 */
const UNORDERED_KEYWORDS = new Set(["enum", "required", "type"]);

/** Keywords whose value is DATA, not schema: an array in it keeps its order whatever its keys are called. */
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

/** Keywords whose value maps NAMES to subschemas: a property called `default` or `enum` is a name, not a keyword. */
const NAME_MAP_KEYWORDS = new Set(["$defs", "definitions", "dependencies", "dependentRequired", "dependentSchemas", "patternProperties", "properties"]);

/**
 * `value` with every object's keys sorted and, in schema position only, each set keyword's list sorted by its members'
 * canonical JSON. Inside data (`inData`) nothing but key order changes, so two different constants never hash alike; in a
 * name map (`names`) each key is a name whose value is a subschema again.
 */
const canonical = (value: unknown, inData: boolean, names = false): unknown => {
    if (Array.isArray(value)) {
        return value.map((member: unknown) => canonical(member, inData));
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    const object = value as { [key: string]: unknown };

    return Object.fromEntries(
        Object.keys(object)
            .toSorted(byCodeUnit)
            .map((key) => {
                if (names) {
                    const entry = canonical(object[key], inData);

                    // A dependency's list of property names (`dependencies`, `dependentRequired`) is a set, like `required`.
                    return [
                        key,
                        Array.isArray(entry) && !inData && entry.every((item) => typeof item === "string") ? (entry as string[]).toSorted(byCodeUnit) : entry,
                    ];
                }

                const member = canonical(object[key], inData || DATA_KEYWORDS.has(key), !inData && NAME_MAP_KEYWORDS.has(key));
                const isSet = !inData && UNORDERED_KEYWORDS.has(key) && Array.isArray(member);

                return [key, isSet ? (member as unknown[]).toSorted((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))) : member];
            }),
    );
};

/** JSON with every object's keys sorted, so the same schema served in another key order hashes the same. */
const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value, false));

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** How long a schema that resolves lazily may take. Past it the tool is not fingerprinted, so it never holds up a run. */
export const FINGERPRINT_DEADLINE_MS = 2000;

/** The JSON Schema the model is sent for `tool`'s input, or `null` when it declares none. Awaited: a schema may resolve lazily. */
const inputJsonSchema = async (tool: ToolSet[string]): Promise<unknown> => {
    if (tool.inputSchema === undefined) {
        return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            Promise.resolve(asSchema(tool.inputSchema).jsonSchema),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Input schema did not resolve within ${FINGERPRINT_DEADLINE_MS}ms`)), FINGERPRINT_DEADLINE_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export interface FingerprintedTool {
    annotations?: ToolAnnotationHints;
    /** The connector the tool came through. With it the server is the connector, whatever its name or address. */
    connectorSlug?: string;
    /** How the calls travel: the same address over another transport is another server. */
    protocol: string;
    serverName: string;
    toolName: string;
    /** Where the tool's calls go, a connector's included: the same tool behind another address is another tool. */
    url: string;
}

/** The fingerprint of one MCP tool as `getMCPTools` received it from its server. */
export const fingerprintMcpTool = async (tool: ToolSet[string], source: FingerprintedTool): Promise<string> => {
    // The behaviour hints only: the annotations' title is a display name, and renaming a tool on screen changes no call.
    const hints: ToolAnnotationHints & { idempotentHint?: boolean } = source.annotations ?? {};
    const identity = canonicalJson({
        annotations: {
            destructiveHint: hints.destructiveHint ?? null,
            idempotentHint: hints.idempotentHint ?? null,
            openWorldHint: hints.openWorldHint ?? null,
            readOnlyHint: hints.readOnlyHint ?? null,
        },
        input: await inputJsonSchema(tool),
        server: {
            ...(source.connectorSlug === undefined ? { name: source.serverName } : { connector: source.connectorSlug }),
            protocol: source.protocol,
            url: source.url,
        },
        tool: source.toolName,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));

    return toHex(digest).slice(0, FINGERPRINT_HEX_LENGTH);
};

export type McpToolDrift = "changed" | "removed" | "unchanged" | "unverified";

/**
 * How the MCP tool `name` stands now against the run that paused. `unchanged` also covers a tool the snapshot did not
 * fingerprint (a built-in or device tool, or a snapshot written before fingerprints were recorded): those keep the
 * checks they had. `offered`: the tool is in the rebuilt run, so one with no current fingerprint (it could not be hashed
 * this time) is `unverified`, not `removed`.
 */
export const mcpToolDrift = (
    saved: Readonly<Record<string, string>> | undefined,
    current: Readonly<Record<string, string>>,
    name: string,
    offered: boolean,
): McpToolDrift => {
    const before = saved && Object.hasOwn(saved, name) ? saved[name] : undefined;

    if (before === undefined) {
        return "unchanged";
    }

    if (!Object.hasOwn(current, name)) {
        return offered ? "unverified" : "removed";
    }

    return current[name] === before ? "unchanged" : "changed";
};

/** What the model reads in place of the result of an approved call whose tool changed, went away or could not be checked. */
export const mcpToolDriftReason = (drift: Exclude<McpToolDrift, "unchanged">): string => {
    switch (drift) {
        case "changed": {
            return "This call was not run: the tool's definition changed on its server after the call was approved. Read the tool's current inputs and call it again if it is still needed.";
        }
        case "unverified": {
            return "This call was not run: the tool could not be checked against the definition it was approved for. It is still available; call it again if it is still needed.";
        }
        default: {
            return "This call was not run: the tool is not available now. Its server may be unreachable or no longer offer it, or it was switched off, after the call was approved.";
        }
    }
};
