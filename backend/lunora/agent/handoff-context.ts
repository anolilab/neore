/**
 * Where a switch's handoff goes in the context a model is sent (plans/harness-switch.md, S2).
 *
 * The rows of the active path are walked in order, dividers included:
 *
 * - a `portable` divider drops everything before it and puts its stored handoff first — right after the
 *   system prompt, ahead of every turn that follows the switch;
 * - a `delta` divider restores what the target agent had seen when it left (the rows before ITS earlier
 *   divider) and adds the stored handoff of what happened since (none, when nothing did);
 * - a `full` divider changes nothing.
 *
 * The handoff text is read from the divider, never rebuilt, so turn 1 and turn 3 after a switch send the
 * same bytes at the same place.
 */
import type { ModelMessage } from "ai";

import { agentSwitchOf } from "./agent-switch-logic";
import { docsToModelMessages } from "./mapping";

interface PathRow {
    _id: string;
    providerMetadata?: unknown;
}

export interface HandoffContext<D extends PathRow> {
    /** Each handoff to insert before `docs[before]`; `docs.length` places one after the last. */
    blocks: { before: number; text: string }[];
    /** The rows that stay in the context, in order. */
    docs: D[];
}

type Item<D> = { block: string } | { doc: D };

const blocksOf = <D>(texts: ReadonlyArray<string>): Item<D>[] =>
    texts.map((block) => {
        return { block };
    });

/**
 * Whether the window starts below the handoff it needs: no `portable` divider in it, which would drop
 * everything before itself anyway. A `delta` keeps what came before, so it does not count.
 */
export const needsEarlierHandoff = (docs: ReadonlyArray<PathRow>): boolean =>
    !docs.some((doc) => {
        const part = agentSwitchOf(doc);

        return part?.mode === "portable" && Boolean(part.handoff);
    });

/**
 * The `delta` dividers of the window whose target never left inside it: the divider it left through is above
 * the window, so what it saw is not in `docs` and `assembleHandoffContext` takes it from `deltaBases`, by model.
 * One per model — the first is the one that needs it.
 */
export const deltaOrphans = (docs: ReadonlyArray<PathRow>): { id: string; model: string }[] => {
    const left = new Set<string>();
    const orphans = new Map<string, string>();

    for (const doc of docs) {
        const part = agentSwitchOf(doc);

        if (!part) {
            continue;
        }

        if (part.mode === "delta" && !left.has(part.to.model) && !orphans.has(part.to.model)) {
            orphans.set(part.to.model, doc._id);
        }

        left.add(part.from.model);
    }

    return [...orphans].map(([model, id]) => {
        return { id, model };
    });
};

/**
 * @param docs the active path ending at the prompt, oldest first (dividers among them)
 * @param earlierHandoffs the stored handoffs of dividers older than `docs` — the path window starts below them —
 * when the walk met no `portable` one: they stand in for everything before the first row
 * @param deltaBases what a `delta` divider's target saw when it left, for the models `deltaOrphans` names
 */
export const assembleHandoffContext = <D extends PathRow>(
    docs: ReadonlyArray<D>,
    earlierHandoffs: ReadonlyArray<string> = [],
    deltaBases: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): HandoffContext<D> => {
    let items: Item<D>[] = blocksOf(earlierHandoffs);
    // What each agent had when it last left, keyed by its model: the state before the divider that moved on from it.
    const seenBy = new Map<string, Item<D>[]>();

    for (const doc of docs) {
        const part = agentSwitchOf(doc);

        if (!part) {
            items.push({ doc });

            continue;
        }

        seenBy.set(part.from.model, [...items]);

        if (part.mode === "portable" && part.handoff) {
            items = [{ block: part.handoff }];
        } else if (part.mode === "delta") {
            // A delta without a handoff is a switch back with nothing missed: the agent sees what it saw.
            const seen = seenBy.get(part.to.model) ?? blocksOf<D>(deltaBases.get(part.to.model) ?? []);

            items = part.handoff ? [...seen, { block: part.handoff }] : [...seen];
        }
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
 * authority. The cache hint lets a provider that honours it (Anthropic) cache the prefix through the handoff;
 * it goes on the last handoff only, because a provider allows four breakpoints and the gateway sets two.
 */
export const handoffMessage = (text: string, cache = true): ModelMessage =>
    ({ content: text, ...(cache && { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }), role: "user" }) as ModelMessage;

/** The rows as model messages, with each handoff placed before the row `blocks` name. `docs` is the list `assembleHandoffContext` kept, possibly with media re-signed. */
export const withHandoff = (docs: Parameters<typeof docsToModelMessages>[0], blocks: HandoffContext<PathRow>["blocks"]): ModelMessage[] => {
    const messages: ModelMessage[] = [];
    const last = blocks.at(-1);
    const textsBefore = (index: number): ModelMessage[] =>
        blocks.filter((block) => Math.min(block.before, docs.length) === index).map((block) => handoffMessage(block.text, block === last));

    for (const [index, doc] of docs.entries()) {
        messages.push(...textsBefore(index), ...docsToModelMessages([doc]));
    }

    messages.push(...textsBefore(docs.length));

    return messages;
};
