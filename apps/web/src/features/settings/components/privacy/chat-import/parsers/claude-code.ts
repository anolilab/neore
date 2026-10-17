/**
 * Parser for local Claude Code session transcripts (`<session>.jsonl`).
 *
 * One JSON event per line. `user` and `assistant` events carry a `message`
 * whose `content` is a string or an array of blocks (`text`, `thinking`,
 * `tool_use`, `tool_result`). Only text is kept; sidechain (sub-agent) and
 * meta events are skipped.
 */
import type { InjectedBlock } from "./local-session";
import { asRecord, buildSession, isInjectedText, messageFromTexts, parseTimestamp } from "./local-session";
import type { NormalizedConversation, NormalizedMessage } from "./types";

// A slash-command echo is several tags in one block (message, name, args), so it is matched by its
// opening tag alone. A block that ends with a fixed closing tag must open and close with it.
const HARNESS_BLOCKS: InjectedBlock[] = [
    { open: "<command-name>" },
    { open: "<command-message>" },
    { open: "<local-command-" },
    { close: "</system-reminder>", open: "<system-reminder>" },
    { open: "Caveat: The messages below" },
];

export const isClaudeCodeRecord = (record: unknown): boolean => {
    const item = asRecord(record);

    return typeof item?.sessionId === "string" && (item.type === "user" || item.type === "assistant") && asRecord(item.message) !== undefined;
};

const isMainMessage = (event: Record<string, unknown>): boolean =>
    (event.type === "user" || event.type === "assistant") && event.isSidechain !== true && event.isMeta !== true;

/**
 * The events on the ACTIVE branch. A resumed session keeps its abandoned forks in
 * the same file, linked by `parentUuid`; the active branch ends at the last main
 * message in file order and runs back to the root. Events without a uuid (titles,
 * snapshots) are kept as they are.
 */
const activeBranch = (events: Record<string, unknown>[]): Record<string, unknown>[] => {
    const byUuid = new Map<string, Record<string, unknown>>();

    for (const event of events) {
        if (typeof event.uuid === "string") {
            byUuid.set(event.uuid, event);
        }
    }

    const leaf = events.findLast((event) => isMainMessage(event) && typeof event.uuid === "string");

    if (!leaf) {
        return events;
    }

    const onBranch = new Set<string>();

    for (let node: Record<string, unknown> | undefined = leaf; node && typeof node.uuid === "string" && !onBranch.has(node.uuid);) {
        onBranch.add(node.uuid);
        // A compaction boundary has an empty parentUuid; its old link lives on as logicalParentUuid.
        const parent: unknown = typeof node.parentUuid === "string" && node.parentUuid !== "" ? node.parentUuid : node.logicalParentUuid;

        node = typeof parent === "string" ? byUuid.get(parent) : undefined;
    }

    return events.filter((event) => typeof event.uuid !== "string" || onBranch.has(event.uuid));
};

const parseClaudeCode = (data: unknown): NormalizedConversation[] => {
    if (!Array.isArray(data)) {
        throw new TypeError("Expected an array of session events");
    }

    const messages: NormalizedMessage[] = [];
    let dropped = 0;
    let title: string | undefined;
    const events = data.map((raw) => asRecord(raw)).filter((event): event is Record<string, unknown> => event !== undefined);

    for (const event of activeBranch(events)) {
        if (event.type === "summary" && typeof event.summary === "string") {
            title ??= event.summary;

            continue;
        }

        if ((event.type !== "user" && event.type !== "assistant") || event.isSidechain === true || event.isMeta === true) {
            continue;
        }

        const content = asRecord(event.message)?.content;
        let blocks: unknown[] = [];

        if (typeof content === "string") {
            blocks = [{ text: content, type: "text" }];
        } else if (Array.isArray(content)) {
            blocks = content;
        }

        const texts: string[] = [];

        for (const block of blocks) {
            const item = asRecord(block);

            if (item?.type === "text" && typeof item.text === "string") {
                texts.push(item.text);
            } else if (item?.type === "tool_use" || item?.type === "tool_result" || item?.type === "thinking") {
                dropped += 1;
            }
        }

        // A harness block (a reminder, a command echo) is not the user's words; the prompt beside it is.
        const kept = texts.filter((text) => !isInjectedText(text, HARNESS_BLOCKS));
        const message = messageFromTexts(kept, event.type, parseTimestamp(event.timestamp), HARNESS_BLOCKS);

        if (message) {
            messages.push(message);
        }
    }

    const session = buildSession(messages, dropped, title);

    return session ? [session] : [];
};

export default parseClaudeCode;
