/**
 * Validates the tool list of a VERIFIED device manifest. The signature proves
 * the device's Rust core produced it; this bounds what even a well-signed
 * manifest can put in front of the model (names, sizes, a schema the provider
 * will accept).
 */
import type { Infer } from "lunorash/server";

import type { vAcpOffer, vDeviceManifestTool } from "../validators";
import { ACP_TOOLS, MAX_MANIFEST_DESCRIPTION_CHARS, MAX_MANIFEST_OFFERS, MAX_MANIFEST_SCHEMA_BYTES, MAX_MANIFEST_TOOLS } from "./constants";
import { utf8Length } from "./signing";

export type DeviceManifestTool = Infer<typeof vDeviceManifestTool>;
export type AcpOffer = Infer<typeof vAcpOffer>;

/** Tool names the device may advertise: `fs_read`, `shell_run`, `mcp__<server>__<tool>`. */
export const DEVICE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

const KINDS: ReadonlySet<string> = new Set(["fs", "mcp", "shell"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const parseManifestTools = (value: unknown): DeviceManifestTool[] | null => {
    if (!Array.isArray(value) || value.length > MAX_MANIFEST_TOOLS) {
        return null;
    }

    const seen = new Set<string>();
    const tools: DeviceManifestTool[] = [];

    for (const entry of value as unknown[]) {
        if (!isRecord(entry)) {
            return null;
        }

        const { description, inputSchema, kind, name, readOnly } = entry;

        // The coding-agent call names are the backend's own (`acp-call.ts`), which it sends and the computer never offers: a device
        // tool by one of them would be given an `acp_*` call's budget and claim window and reach the model as a device tool.
        if (typeof name !== "string" || !DEVICE_TOOL_NAME.test(name) || seen.has(name) || ACP_TOOLS.includes(name)) {
            return null;
        }

        if (typeof kind !== "string" || !KINDS.has(kind) || typeof readOnly !== "boolean" || typeof description !== "string") {
            return null;
        }

        if (!isRecord(inputSchema) || inputSchema.type !== "object" || utf8Length(JSON.stringify(inputSchema)) > MAX_MANIFEST_SCHEMA_BYTES) {
            return null;
        }

        seen.add(name);
        tools.push({
            description: description.slice(0, MAX_MANIFEST_DESCRIPTION_CHARS),
            inputSchema,
            kind: kind as DeviceManifestTool["kind"],
            name,
            readOnly,
        });
    }

    return tools;
};

const OFFER_FIELD_LIMITS = { agentKey: 128, agentLabel: 200, folderId: 128, folderLabel: 200 } as const;

/**
 * The coding-agent pairs a verified manifest offers. A manifest without the field is one from a shell that
 * predates coding agents and offers none; a malformed list is refused whole, like a malformed tool list. Fields
 * are bounded here and a pair appears once, so the list the web shows is the list Rust would accept.
 */
export const parseAcpOffers = (value: unknown): AcpOffer[] | null => {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > MAX_MANIFEST_OFFERS) {
        return null;
    }

    const seen = new Set<string>();
    const offers: AcpOffer[] = [];

    for (const entry of value as unknown[]) {
        if (!isRecord(entry)) {
            return null;
        }

        const offer = {} as Record<keyof typeof OFFER_FIELD_LIMITS, string>;

        for (const [field, limit] of Object.entries(OFFER_FIELD_LIMITS)) {
            const text = entry[field];

            if (typeof text !== "string" || text.length === 0) {
                return null;
            }

            // An id is refused when too long (the pair could not be matched); a label is only shown, so a long folder
            // name is cut instead of costing the computer every later manifest.
            if (text.length > limit && !field.endsWith("Label")) {
                return null;
            }

            offer[field as keyof typeof OFFER_FIELD_LIMITS] = text.slice(0, limit);
        }

        const key = `${offer.agentKey}\n${offer.folderId}`;

        if (!seen.has(key)) {
            seen.add(key);
            offers.push(offer);
        }
    }

    return offers;
};
