/**
 * Which tool results the thread page sends inline. The page is re-pushed on every write to
 * the rows it reads, so a large result that the page does not paint is left out of it and
 * fetched on expand (`getToolOutput`).
 *
 * A tool whose own view reads `output` on first render keeps it inline, whatever its size.
 * Add a name here when you add such a view; `tool-output-policy.test.ts` checks the renderer
 * registries against this list.
 */

/** Results at or below this many bytes stay inline: a fetch would cost more than the bytes it saves. */
export const TOOL_OUTPUT_INLINE_BYTES = 4096;

/** Tool names (without the `tool-` prefix) whose view reads `output` on first render. */
export const FIRST_PAINT_TOOL_NAMES: ReadonlySet<string> = new Set([
    // Own cards and questions
    "askUser",
    "browser",
    "codeExecution",
    // Result widgets
    "coinData",
    "coinDataByContract",
    "createDocument",
    "createPresentation",
    "currencyConverter",
    "deepResearch",
    // Sub-agent and coding-agent views
    "delegateToCodingAgent",
    "delegateToSubAgent",
    "findPlace",
    "flightTracker",
    "imageSearch",
    "messageWorker",
    "nearbyPlacesSearch",
    "renderUI",
    "requestSecret",
    "shellExecution",
    "stockChart",
    "updateDocument",
    "updateSlide",
    "videoSearch",
    "weather",
    "webSearch",
    "wolframAlpha",
]);

/** Device tools render through `DeviceToolCall`, which reads `output`. */
const DEVICE_TOOL_TYPE = /^tool-device_[a-z0-9]{1,6}__/u;

/** The part fields that decide whether the output stays inline. */
export interface ToolPartShape {
    callProviderMetadata?: unknown;
    state?: string;
    type: string;
}

/** Where a trimmed output lives, so it can be fetched back. */
export interface ToolOutputRef {
    messageId: string;
    threadId: string;
    toolCallId: string;
}

const isMcpPart = (part: ToolPartShape): boolean => {
    if (part.type.startsWith("tool-mcp_")) {
        return true;
    }

    const neore = (part.callProviderMetadata as { neore?: { mcpServerName?: unknown } } | undefined)?.neore;

    return typeof neore?.mcpServerName === "string";
};

/** True when a view of this part reads its output on first render, so the output must stay inline. */
export const isOutputInline = (part: ToolPartShape): boolean => {
    const name = part.type.slice("tool-".length);

    return FIRST_PAINT_TOOL_NAMES.has(name) || DEVICE_TOOL_TYPE.test(part.type) || isMcpPart(part);
};

const TEXT_ENCODER = new TextEncoder();

/** True when a finished tool part's output may be left out of the page and fetched on expand. */
export const isTrimmableToolOutput = (part: ToolPartShape, output: unknown): boolean => {
    if (!part.type.startsWith("tool-") || part.state !== "output-available" || isOutputInline(part)) {
        return false;
    }

    return TEXT_ENCODER.encode(JSON.stringify(output)).byteLength > TOOL_OUTPUT_INLINE_BYTES;
};
