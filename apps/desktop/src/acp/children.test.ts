/**
 * The ledger of an agent's own children (`children.ts`, plans/acp-agent-host.md §4.7): ownership by the spawn call,
 * a byte-budgeted buffer for events that arrive before their card, and a card that ends once.
 */
import { describe, expect, it } from "vitest";

import type { ChildEvent } from "./children";
import { ChildLedger } from "./children";

const rig = (options: { budgetBytes?: number; scrub?: (text: string) => string; secretLength?: number } = {}) => {
    const emitted: [string, ChildEvent][] = [];
    const logs: string[] = [];
    const ledger = new ChildLedger({
        budgetBytes: options.budgetBytes,
        emit: (spawnId, event) => {
            emitted.push([spawnId, event]);
        },
        log: (message) => {
            logs.push(message);
        },
        scrub: options.scrub ?? ((text) => text),
        secretLength: options.secretLength ?? 0,
    });

    return { emitted, ledger, logs };
};

const text = (value: string): ChildEvent => {
    return { kind: "text", text: value };
};

describe("a child's events", () => {
    it("are shown at once when their spawn call is already there", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("task1");
        ledger.receive("task1", text("looking"));

        expect(emitted).toEqual([["task1", text("looking")]]);
    });

    it("that arrive before the spawn call are shown after it appears, in order, once", () => {
        const { emitted, ledger } = rig();

        ledger.receive("task1", text("a"));
        ledger.receive("task1", { id: "c1", kind: "tool", status: "pending", title: "Read", toolKind: "read" });
        ledger.receive("task1", text("b"));
        expect(emitted).toEqual([]);

        ledger.spawn("task1");
        ledger.spawn("task1");
        ledger.receive("task1", text("c"));

        expect(emitted.map(([, event]) => event.kind)).toEqual(["text", "tool", "text", "text"]);
        expect(emitted.filter(([, event]) => event.kind === "text").map(([, event]) => (event as { text: string }).text)).toEqual(["a", "b", "c"]);
    });

    it("never make a card of their own: a child that names a call that never appears shows nothing", () => {
        const { emitted, ledger, logs } = rig();

        ledger.receive("ghost", text("hello"));
        ledger.discardUnclaimed();

        expect(emitted).toEqual([]);
        expect(logs.join("\n")).toContain("1 child events never met their parent");

        // A spawn that comes afterwards finds nothing left to show.
        ledger.spawn("ghost");
        expect(emitted).toEqual([]);
    });

    it("keep to one parent each: one spawn call's events do not reach another's card", () => {
        const { emitted, ledger } = rig();

        ledger.receive("a", text("for a"));
        ledger.receive("b", text("for b"));
        ledger.spawn("b");

        expect(emitted).toEqual([["b", text("for b")]]);
    });
});

describe("the buffer for events that arrive early", () => {
    it("drops what passes its byte budget, logs it, and stores none of it", () => {
        const one = JSON.stringify(text("x".repeat(100))).length;
        const { emitted, ledger, logs } = rig({ budgetBytes: one * 2 });

        ledger.receive("task1", text("x".repeat(100)));
        ledger.receive("task1", text("x".repeat(100)));
        ledger.receive("task1", text("y".repeat(100)));
        ledger.spawn("task1");

        expect(emitted.map(([, event]) => (event as { text: string }).text[0])).toEqual(["x", "x"]);
        expect(ledger.stats()).toEqual({ dropped: 1, peakBytes: one * 2 });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("passed the");
    });

    it("gives its room back once the card appears", () => {
        const one = JSON.stringify(text("x".repeat(100))).length;
        const { emitted, ledger } = rig({ budgetBytes: one });

        ledger.receive("a", text("x".repeat(100)));
        ledger.spawn("a");
        ledger.receive("b", text("x".repeat(100)));
        ledger.spawn("b");

        expect(emitted).toHaveLength(2);
        expect(ledger.stats().dropped).toBe(0);
    });

    it("measures the most it ever held, for the budget to be set from", () => {
        const { ledger } = rig();

        ledger.receive("a", text("x".repeat(1000)));
        ledger.spawn("a");
        ledger.receive("b", text("y"));

        expect(ledger.stats().peakBytes).toBeGreaterThanOrEqual(1000);
        expect(ledger.stats().dropped).toBe(0);
    });
});

describe("a card ending", () => {
    it("ends once: a second terminal event and anything after it are ignored", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("task1");
        ledger.receive("task1", text("working"));
        ledger.settle("task1", "completed");
        ledger.settle("task1", "failed");
        ledger.endAll("cancelled");
        ledger.receive("task1", text("late"));

        expect(emitted.map(([, event]) => event.kind)).toEqual(["text", "end"]);
        expect(emitted.at(-1)?.[1]).toEqual({ kind: "end", status: "completed" });
    });

    it("keeps a completion's full text when the child streamed none, and drops it after streamed text", () => {
        const silent = rig();

        silent.ledger.spawn("t");
        silent.ledger.receive("t", { id: "c1", kind: "tool", status: "completed", title: "Read", toolKind: "read" });
        silent.ledger.settle("t", "completed", "All done: two files changed.");
        expect(silent.emitted.at(-1)?.[1]).toEqual({ kind: "end", status: "completed", text: "All done: two files changed." });

        const talkative = rig();

        talkative.ledger.spawn("t");
        talkative.ledger.receive("t", text("All done: two files changed."));
        talkative.ledger.settle("t", "completed", "All done: two files changed.");
        expect(talkative.emitted.at(-1)?.[1]).toEqual({ kind: "end", status: "completed" });
    });

    it("is not made for a spawn call whose child never said anything", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("task1");
        ledger.settle("task1", "completed", "done");
        ledger.endAll("failed");

        expect(emitted).toEqual([]);
    });

    it("ends every open card when the turn is cancelled", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("a");
        ledger.spawn("b");
        ledger.receive("a", text("x"));
        ledger.receive("b", text("y"));
        ledger.settle("a", "completed");
        ledger.endAll("cancelled");

        expect(emitted.filter(([, event]) => event.kind === "end").map(([spawnId, event]) => [spawnId, (event as { status: string }).status])).toEqual([
            ["a", "completed"],
            ["b", "cancelled"],
        ]);
    });
});

describe("the cards a session keeps", () => {
    it("drops those whose child never spoke when the turn ends, and keeps the ones that did", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("quiet");
        ledger.spawn("spoke");
        ledger.receive("spoke", text("hi"));
        ledger.discardUnclaimed();

        // The quiet card is gone: an event for it now waits for a spawn call, as for any call that has not appeared.
        ledger.receive("quiet", text("late"));
        ledger.receive("spoke", text("again"));

        expect(emitted.map(([spawnId]) => spawnId)).toEqual(["spoke", "spoke"]);
    });

    it("lets an ended card go of its text, and still ignores what comes after it", () => {
        const { emitted, ledger } = rig();

        ledger.spawn("a");
        ledger.receive("a", text("x".repeat(1000)));
        ledger.settle("a", "completed");
        ledger.receive("a", text("late"));
        ledger.settle("a", "failed");

        expect(emitted.map(([, event]) => event.kind)).toEqual(["text", "end"]);
        expect(JSON.stringify((ledger as unknown as { cards: Map<string, unknown> }).cards.get("a"))).toBe("{\"ended\":true,\"hasChildren\":true}");
    });
});

describe("a child's text and the user's masked values", () => {
    it("is held back until a masked value can be recognised, and released when the card ends", () => {
        const secret = "hunter22";
        const { emitted, ledger } = rig({ scrub: (value) => value.replaceAll(secret, "***"), secretLength: secret.length });

        ledger.spawn("t");
        ledger.receive("t", text("the key is hunt"));
        ledger.receive("t", text("er22 ok"));
        ledger.settle("t", "completed");

        const shown = emitted.flatMap(([, event]) => event.kind === "text" ? [event.text] : []).join("");

        expect(shown).toBe("the key is *** ok");
        expect(shown).not.toContain("hunt");
    });

    it("masks a completion's text and a child tool's title", () => {
        const secret = "hunter22";
        const { emitted, ledger } = rig({ scrub: (value) => value.replaceAll(secret, "***"), secretLength: secret.length });

        ledger.spawn("t");
        ledger.receive("t", { id: "c", kind: "tool", status: "pending", title: "curl hunter22", toolKind: "execute" });
        ledger.settle("t", "completed", "used hunter22");

        expect(JSON.stringify(emitted)).not.toContain(secret);
    });
});
