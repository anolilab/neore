/**
 * Child agents an agent starts of its own (plans/acp-agent-host.md §4.7).
 *
 * A child belongs to the tool call that spawned it, and is shown only when the agent reports its children (the
 * `subagents.ownChildren` capability, decided by the session). The session hands this ledger what the children
 * send; the ledger decides what the thread is told:
 *
 * **Ownership is the spawn call's id.** An event names its parent; it never creates a card on its own. A card exists
 * once the session has seen the spawn call (`spawn`).
 *
 * **An event that arrives before its card is held**, in order, in one buffer per session with a fixed byte budget.
 * Past the budget an event is dropped and logged, never stored. The buffer is emptied into the card when the spawn
 * call appears, and what no spawn claimed is dropped when the turn ends.
 *
 * **A card ends once.** A child's completion ends it; a second terminal event and anything after it are ignored. A
 * completion that brings text keeps it only when the child streamed none: otherwise it would show the text twice.
 *
 * **Masked text.** The text a child streamed is masked with the user's variable values before it leaves, holding back
 * the longest value's length until the card ends, as the parent's text is (`session.ts`).
 *
 * Nothing here talks to the agent or the backend: `emit` is the only way out.
 */
import { Buffer } from "node:buffer";

import { MaskedStream, MAX_CHILD_TEXT } from "./masked-stream";

/**
 * Bytes of child events held for a spawn call that has not appeared, per session. The manager runs at most 8 sessions
 * at once (`MAX_SESSIONS`), and an ended session empties its buffer, so everything held across sessions stays under 8
 * times this. **Not measured:** a provisional figure derived from the caps around it (plans/acp-s7-children.md): the
 * agent's own buffer for the same ordering problem holds at most 256 updates, and one post carries 200 KB
 * (`MAX_BATCH_BYTES`), a turn's unsent output 4 MB. Pending measurement on a real child-heavy session.
 */
export const CHILD_BUFFER_BUDGET_BYTES = 512 * 1024;

export type ChildEvent
    = | { id: string; kind: "tool"; status: string; title: string; toolKind: string }
        | { kind: "end"; status: ChildEnd; text?: string }
        | { kind: "reasoning"; text: string }
        | { kind: "text"; text: string };

export type ChildEnd = "cancelled" | "completed" | "failed";

export interface ChildStats {
    /** Events dropped for want of room. */
    dropped: number;
    /** The most bytes held at once, since the ledger began. */
    peakBytes: number;
}

export interface ChildLedgerOptions {
    budgetBytes?: number;
    /** Where a child's event goes: the spawn call's id, the event. */
    emit: (spawnId: string, event: ChildEvent) => void;
    log?: (message: string) => void;
    scrub: (text: string) => string;
    /** Length of the longest masked value; 0 when none is set. */
    secretLength: number;
}

interface Card {
    /** Set once the card ended. What it held is released then; the card stays as the record that it ended, so a repeat is ignored. */
    ended: boolean;
    /** Whether the child has said anything: a spawn call with no children is not a card the thread shows. */
    hasChildren: boolean;
    reasoning?: MaskedStream;
    text?: MaskedStream;
}

const bytesOf = (event: ChildEvent): number => Buffer.byteLength(JSON.stringify(event));

export class ChildLedger {
    private readonly buffer = new Map<string, ChildEvent[]>();

    private bufferedBytes = 0;

    private readonly cards = new Map<string, Card>();

    private dropped = 0;

    private peakBytes = 0;

    public constructor(private readonly options: ChildLedgerOptions) {}

    public stats(): ChildStats {
        return { dropped: this.dropped, peakBytes: this.peakBytes };
    }

    /** The spawn call has appeared: its card exists, and what was held for it follows, in order. */
    public spawn(spawnId: string): void {
        if (this.cards.has(spawnId)) {
            return;
        }

        this.cards.set(spawnId, { ended: false, hasChildren: false });

        const held = this.buffer.get(spawnId) ?? [];

        this.buffer.delete(spawnId);
        this.bufferedBytes -= held.reduce((sum, event) => sum + bytesOf(event), 0);

        for (const event of held) {
            this.deliver(spawnId, event);
        }
    }

    /** A child's event, by the spawn call that owns it. Held when the card is not there yet. */
    public receive(spawnId: string, event: ChildEvent): void {
        if (this.cards.has(spawnId)) {
            this.deliver(spawnId, event);

            return;
        }

        const size = bytesOf(event);
        const budget = this.options.budgetBytes ?? CHILD_BUFFER_BUDGET_BYTES;

        if (this.bufferedBytes + size > budget) {
            this.dropped += 1;

            if (this.dropped === 1) {
                this.options.log?.(`[acp-host] child output arrived before its parent and passed the ${String(budget)}-byte buffer; the excess is dropped`);
            }

            return;
        }

        this.bufferedBytes += size;
        this.peakBytes = Math.max(this.peakBytes, this.bufferedBytes);
        this.buffer.set(spawnId, [...this.buffer.get(spawnId) ?? [], event]);
    }

    /** The spawn call itself finished. Ends the card of a child that spoke; a call that had no children has none. */
    public settle(spawnId: string, status: ChildEnd, text?: string): void {
        if (this.cards.get(spawnId)?.hasChildren !== true) {
            return;
        }

        this.deliver(spawnId, { kind: "end", status, ...text !== undefined && text !== "" && { text } });
    }

    /** Every card still open ends: the turn was cancelled, or the session is over. */
    public endAll(status: ChildEnd): void {
        for (const [spawnId, card] of this.cards) {
            if (card.hasChildren && !card.ended) {
                this.deliver(spawnId, { kind: "end", status });
            }
        }
    }

    /**
     * What no spawn call claimed is dropped, and said so. So are the cards of spawn calls whose child never said
     * anything: they would be kept for as long as the session lives, one per tool call.
     */
    public discardUnclaimed(): void {
        let count = 0;

        for (const [spawnId, card] of this.cards) {
            if (!card.hasChildren) {
                this.cards.delete(spawnId);
            }
        }

        for (const events of this.buffer.values()) {
            count += events.length;
        }

        this.buffer.clear();
        this.bufferedBytes = 0;

        if (count > 0) {
            this.options.log?.(`[acp-host] ${String(count)} child events never met their parent and were dropped`);
        }
    }

    private deliver(spawnId: string, event: ChildEvent): void {
        const card = this.cards.get(spawnId);

        if (card === undefined || card.ended) {
            return;
        }

        card.hasChildren = true;

        if (event.kind === "text" || event.kind === "reasoning") {
            card.text ??= new MaskedStream(this.options);
            card.reasoning ??= new MaskedStream(this.options);

            const delta = (event.kind === "text" ? card.text : card.reasoning).take(event.text);

            if (delta !== "") {
                this.options.emit(spawnId, { kind: event.kind, text: delta });
            }

            return;
        }

        if (event.kind === "tool") {
            this.options.emit(spawnId, { ...event, title: this.options.scrub(event.title) });

            return;
        }

        this.end(spawnId, event);
    }

    private end(spawnId: string, event: Extract<ChildEvent, { kind: "end" }>): void {
        const card = this.cards.get(spawnId) as Card;
        const streamed = { reasoning: card.reasoning, text: card.text };

        // Released at once: the card is a tombstone from here, a few bytes however much the child said.
        card.ended = true;
        delete card.reasoning;
        delete card.text;

        for (const kind of ["text", "reasoning"] as const) {
            const rest = streamed[kind]?.take("", true) ?? "";

            if (rest !== "") {
                this.options.emit(spawnId, { kind, text: rest });
            }
        }

        // The completion's own text stands in for a child that streamed none; after streamed text it would repeat it.
        const text = streamed.text?.isEmpty !== false && event.text !== undefined ? this.options.scrub(event.text).slice(0, MAX_CHILD_TEXT) : undefined;

        this.options.emit(spawnId, { kind: "end", status: event.status, ...text !== undefined && text !== "" && { text } });
    }
}
