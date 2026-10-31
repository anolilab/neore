/**
 * Which untrusted content the model had read before it asked for a device
 * call. Computed from the messages the model saw for that step (AI SDK
 * `ToolExecutionOptions.messages`: earlier turns plus this run's tool results)
 * and SIGNED into the envelope, so the page cannot strip it.
 *
 * A non-empty list makes the device's approval prompt warn and refuse "Always
 * allow", and an existing allow rule does not skip the prompt.
 *
 * Fail closed: a tool result is untrusted unless the tool is on the short list
 * of built-ins whose output is our own.
 */
import type { Infer } from "lunorash/server";

import { parseGoalReviewNote } from "../../chat/goals/shared";
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
    "requestSecret",
    "saveSecretAsProviderKey",
    "setMcpServerSecret",
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

/** The union of taint lists in the stable signed order (a list read from storage may be unsorted or absent). */
export const mergeTaint = (...lists: ReadonlyArray<ReadonlyArray<DeviceTaintSource> | undefined>): DeviceTaintSource[] => {
    const found = new Set(lists.flatMap((list) => list ?? []));

    return TAINT_ORDER.filter((source) => found.has(source));
};

interface MessageLike {
    content?: unknown;
    role?: unknown;
}

/**
 * The taint a goal's instruction row carries: the reviewer's note was written from the round's tool results,
 * so the round that follows is as untrusted as they were. A user message is read, never an assistant one.
 */
const goalNoteTaint = (content: unknown): DeviceTaintSource[] => {
    const texts = Array.isArray(content)
        ? (content as ReadonlyArray<{ text?: unknown; type?: unknown }>).flatMap((part) =>
              part.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
        : [content];

    return texts
        .flatMap((text) => (typeof text === "string" ? (parseGoalReviewNote(text)?.taintedBy ?? []) : []))
        .filter((source): source is DeviceTaintSource => TAINT_ORDER.includes(source as DeviceTaintSource));
};

/** A text part a coding agent on a paired computer wrote (`HOST_TEXT_MARK`); the mark rides as metadata or, once mapped, as options. */
const isHostText = (part: { providerMetadata?: unknown; providerOptions?: unknown }): boolean =>
    [part.providerMetadata, part.providerOptions].some((meta) => (meta as { neore?: { runner?: unknown } } | undefined)?.neore?.runner === "host");

/**
 * The sorted, de-duplicated taint of a message list. Reads only `role`,
 * `content[].type`, `content[].toolName`, a host-text mark on an assistant text part
 * and a goal's review note in a user message, so it takes any model-message shape.
 */
export const computeTaint = (messages: ReadonlyArray<MessageLike> | undefined): DeviceTaintSource[] => {
    const found = new Set<DeviceTaintSource>();

    const list = messages ?? [];

    for (const message of list) {
        if (message.role === "user") {
            for (const source of goalNoteTaint(message.content)) {
                found.add(source);
            }
        }

        if (!Array.isArray(message.content)) {
            continue;
        }

        const parts = message.content as ReadonlyArray<{ providerMetadata?: unknown; providerOptions?: unknown; toolName?: unknown; type?: unknown }>;

        for (const part of parts) {
            if (message.role === "assistant" && part.type === "text" && isHostText(part)) {
                // A coding agent's own text, posted from a paired computer: it read files and command output there.
                found.add("device");
            } else if (part.type === "tool-result" && typeof part.toolName === "string") {
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
