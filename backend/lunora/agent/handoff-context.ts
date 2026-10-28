/**
 * Where a switch's handoff goes in the context a model is sent (plans/harness-switch.md, S2).
 *
 * The rows of the active path are walked in order, dividers included:
 *
 * - a `portable` divider drops everything before it and puts its stored handoff first — right after the
 *   system prompt, ahead of every turn that follows the switch;
 * - a `delta` divider restores what the target agent had seen when it left (the rows before ITS earlier
 *   divider) and adds the stored handoff of what happened since;
 * - a `full` divider, or one without a handoff, changes nothing.
 *
 * The handoff text is read from the divider, never rebuilt, so turn 1 and turn 3 after a switch send the
 * same bytes at the same place.
 */
import type { ModelMessage } from "ai";

import { agentSwitchOf } from "./agent-switch-logic";
import { docsToModelMessages } from "./mapping";

interface PathRow {
    providerMetadata?: unknown;
}

export interface HandoffContext<D extends PathRow> {
    /** Each handoff to insert before `docs[before]`; `docs.length` places one after the last. */
    blocks: { before: number; text: string }[];
    /** The rows that stay in the context, in order. */
    docs: D[];
}

type Item<D> = { block: string } | { doc: D };

/**
 * @param docs the active path ending at the prompt, oldest first (dividers among them)
 * @param earlierHandoff the stored handoff of a divider older than `docs` — the path window starts below it —
 * when the walk met none: it stands in for everything before the first row
 */
export const assembleHandoffContext = <D extends PathRow>(docs: ReadonlyArray<D>, earlierHandoff?: string): HandoffContext<D> => {
    let items: Item<D>[] = earlierHandoff ? [{ block: earlierHandoff }] : [];
    // What each agent had when it last left, keyed by its model: the state before the divider that moved on from it.
    const seenBy = new Map<string, Item<D>[]>();

    for (const doc of docs) {
        const part = agentSwitchOf(doc);

        if (!part) {
            items.push({ doc });

            continue;
        }

        seenBy.set(part.from.model, [...items]);

        if (!part.handoff || part.mode === "full") {
            continue;
        }

        items = part.mode === "delta" && seenBy.has(part.to.model) ? [...seenBy.get(part.to.model)!, { block: part.handoff }] : [{ block: part.handoff }];
    }

    const kept: D[] = [];
    const blocks: HandoffContext<D>["blocks"] = [];

    for (const item of items) {
        if ("block" in item) {
            blocks.push({ before: kept.length, text: item.block });
        } else {
            kept.push(item.doc);
        }
    }

    return { blocks, docs: kept };
};

/**
 * A user message: a transcript's text is not the system's to say, so it must not carry a system message's
 * authority. The cache hint lets a provider that honours it (Anthropic) cache the prefix through the handoff.
 */
export const handoffMessage = (text: string): ModelMessage =>
    ({ content: text, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }, role: "user" }) as ModelMessage;

/** The rows as model messages, with each handoff placed before the row `blocks` name. `docs` is the list `assembleHandoffContext` kept, possibly with media re-signed. */
export const withHandoff = (docs: Parameters<typeof docsToModelMessages>[0], blocks: HandoffContext<PathRow>["blocks"]): ModelMessage[] => {
    const messages: ModelMessage[] = [];
    const textsBefore = (index: number): ModelMessage[] =>
        blocks.filter((block) => Math.min(block.before, docs.length) === index).map((block) => handoffMessage(block.text));

    for (const [index, doc] of docs.entries()) {
        messages.push(...textsBefore(index), ...docsToModelMessages([doc]));
    }

    messages.push(...textsBefore(docs.length));

    return messages;
};
