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
 * `value` with its keys in code-unit order, when it is a plain object. A `required` list is a set, so it is sorted too: a
 * server that writes it from an unordered collection would otherwise hash differently on every listing.
 */
const sortedKeys = (field: string, value: unknown): unknown => {
    if (field === "required" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return (value as string[]).toSorted(byCodeUnit);
    }

    // The allowed values of an `enum` are a set too.
    if (field === "enum" && Array.isArray(value)) {
        return value.toSorted((a: unknown, b: unknown) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }

    const object = value as { [key: string]: unknown };

    return Object.fromEntries(
        Object.keys(object)
            .toSorted(byCodeUnit)
            .map((key) => [key, object[key]]),
    );
};

/** JSON with every object's keys sorted, so the same schema served in another key order hashes the same. */
const canonicalJson = (value: unknown): string => JSON.stringify(value, (key, inner: unknown) => sortedKeys(key, inner));

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The JSON Schema the model is sent for `tool`'s input, or `null` when it declares none. Awaited: a schema may resolve lazily. */
const inputJsonSchema = async (tool: ToolSet[string]): Promise<unknown> =>
    tool.inputSchema === undefined ? null : await asSchema(tool.inputSchema).jsonSchema;

export interface FingerprintedTool {
    annotations?: ToolAnnotationHints;
    /** The connector the tool came through. With it the server is the connector, whatever its name or address. */
    connectorSlug?: string;
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
        server: source.connectorSlug === undefined ? { name: source.serverName, url: source.url } : { connector: source.connectorSlug, url: source.url },
        tool: source.toolName,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));

    return toHex(digest).slice(0, FINGERPRINT_HEX_LENGTH);
};

/**
 * How the MCP tool `name` stands now against the run that paused. `unchanged` also covers a tool the snapshot did not
 * fingerprint (a built-in or device tool, or a snapshot written before fingerprints were recorded): those keep the
 * checks they had.
 */
export const mcpToolDrift = (
    saved: Readonly<Record<string, string>> | undefined,
    current: Readonly<Record<string, string>>,
    name: string,
): "changed" | "removed" | "unchanged" => {
    const before = saved && Object.hasOwn(saved, name) ? saved[name] : undefined;

    if (before === undefined) {
        return "unchanged";
    }

    if (!Object.hasOwn(current, name)) {
        return "removed";
    }

    return current[name] === before ? "unchanged" : "changed";
};

/** What the model reads in place of the result of an approved call whose tool changed or went away during the pause. */
export const mcpToolDriftReason = (drift: "changed" | "removed"): string =>
    drift === "changed"
        ? "This call was not run: the tool's definition changed on its server after the call was approved. Read the tool's current inputs and call it again if it is still needed."
        : "This call was not run: the tool is not available now. Its server may be unreachable or no longer offer it, or it was switched off, after the call was approved.";
