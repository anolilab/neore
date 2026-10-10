/**
 * Which untrusted content the model had read before it asked for a device
 * call. Computed from the messages the model saw for that step (AI SDK
 * `ToolExecutionOptions.messages`: earlier turns plus this run's tool results)
 * and SIGNED into the envelope, so the page cannot strip it.
 *
 * A non-empty list makes the device's approval prompt warn and refuse "Always
 * allow", and an existing allow rule does not skip the prompt
 * (`docs/plans/device-execution.md` §3.8).
 *
 * Fail closed: a tool result is untrusted unless the tool is on the short list
 * of built-ins whose output is our own.
 */
import type { Infer } from "lunorash/server";

import type { vDeviceTaintSource } from "../validators";

export type DeviceTaintSource = Infer<typeof vDeviceTaintSource>;

/** Built-ins whose result is produced by us or by the user, never third-party text. */
const OWN_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
    "askUser",
    "canvasAI",
    "createDesign",
    "createDocument",
    "createPresentation",
    "dateTime",
    "imageGeneration",
    "listCurrencies",
    "listLanguages",
    "musicGeneration",
    "renderUI",
    "taskList",
    "updateDesign",
    "updateDocument",
    "updateSlide",
    "videoGeneration",
]);

const KNOWLEDGE_TOOLS: ReadonlySet<string> = new Set(["knowledgeSearch", "searchMemory"]);

/** The taint one tool result adds; `null` for our own output. */
export const taintOfTool = (toolName: string): DeviceTaintSource | null => {
    if (OWN_OUTPUT_TOOLS.has(toolName)) {
        return null;
    }

    if (toolName.startsWith("device_")) {
        return "device";
    }

    if (toolName.startsWith("mcp_")) {
        return "mcp";
    }

    return KNOWLEDGE_TOOLS.has(toolName) ? "knowledge" : "web";
};

const TAINT_ORDER: ReadonlyArray<DeviceTaintSource> = ["web", "knowledge", "mcp", "device", "files"];

interface MessageLike {
    content?: unknown;
    role?: unknown;
}

/**
 * The sorted, de-duplicated taint of a message list. Reads only `role`,
 * `content[].type` and `content[].toolName`, so it takes any model-message shape.
 */
export const computeTaint = (messages: ReadonlyArray<MessageLike> | undefined): DeviceTaintSource[] => {
    const found = new Set<DeviceTaintSource>();

    const list = messages ?? [];

    for (const message of list) {
        if (!Array.isArray(message.content)) {
            continue;
        }

        const parts = message.content as ReadonlyArray<{ toolName?: unknown; type?: unknown }>;

        for (const part of parts) {
            if (part.type === "tool-result" && typeof part.toolName === "string") {
                const taint = taintOfTool(part.toolName);

                if (taint) {
                    found.add(taint);
                }
            } else if (message.role === "user" && (part.type === "file" || part.type === "image")) {
                found.add("files");
            }
        }
    }

    return TAINT_ORDER.filter((source) => found.has(source));
};
