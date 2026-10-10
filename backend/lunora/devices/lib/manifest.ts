/**
 * Validates the tool list of a VERIFIED device manifest. The signature proves
 * the device's Rust core produced it; this bounds what even a well-signed
 * manifest can put in front of the model (names, sizes, a schema the provider
 * will accept).
 */
import type { Infer } from "lunorash/server";

import type { vDeviceManifestTool } from "../validators";
import { MAX_MANIFEST_DESCRIPTION_CHARS, MAX_MANIFEST_SCHEMA_BYTES, MAX_MANIFEST_TOOLS } from "./constants";
import { utf8Length } from "./signing";

export type DeviceManifestTool = Infer<typeof vDeviceManifestTool>;

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

        if (typeof name !== "string" || !DEVICE_TOOL_NAME.test(name) || seen.has(name)) {
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
