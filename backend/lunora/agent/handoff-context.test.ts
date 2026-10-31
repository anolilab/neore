/**
 * Where a handoff goes in the context (plans/harness-switch.md, S2): first, ahead of the turns after the
 * switch; the same bytes at the same place on every turn; nothing from before a portable divider; and on a
 * switch back only what happened since the agent left.
 */
import { describe, expect, it } from "vitest";

import { agentSwitchRowContent } from "./agent-switch-logic";
import type { AgentSwitchPart } from "./agent-switch-validators";
import { composeHandoff } from "./handoff";
import { assembleHandoffContext, deltaOrphans, handoffMessage, needsEarlierHandoff, withHandoff } from "./handoff-context";
import { planHandoff } from "./handoff";
import { longThreadFixture } from "./handoff.fixture";

const A = { kind: "model" as const, model: "openai/gpt-4.1-mini" };
const B = { kind: "model" as const, model: "google/gemini-2.0-flash-001" };

interface Doc {
    _id: string;
    message?: { content: string; role: "assistant" | "system" | "user" };
    providerMetadata?: unknown;
}

const turn = (id: string, role: "assistant" | "user", content: string): Doc => {
    return { _id: id, message: { content, role } };
};

const divider = (id: string, part: AgentSwitchPart): Doc => {
    return { _id: id, ...agentSwitchRowContent(part) };
};

const handoffOf = (id: string, kind: "delta" | "portable" = "portable") =>
    composeHandoff({ kind, tail: [{ role: "user", text: `what happened up to ${id}` }] });

const textsOf = (docs: Doc[], blocks: { before: number; text: string }[]) =>
    withHandoff(docs as never, blocks).map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));

const contextTexts = (docs: Doc[]): string[] => {
    const context = assembleHandoffContext(docs);

    return textsOf(context.docs, context.blocks);
};

describe("a portable switch", () => {
    const history = [turn("u1", "user", "hello"), turn("a1", "assistant", "hi")];
    const after = [turn("u2", "user", "next question")];
    const handoff = handoffOf("a1");
    const switched = divider("d1", { from: A, handoff, mode: "portable", startMessageId: "a1", summarized: true, to: B });

    it("replaces everything before the divider with the stored handoff, first, then the turns after it", () => {
        const { blocks, docs } = assembleHandoffContext([...history, switched, ...after]);

        expect(docs.map((doc) => doc._id)).toStrictEqual(["u2"]);
        expect(blocks).toStrictEqual([{ before: 0, text: handoff }]);
        expect(textsOf(docs, blocks)).toStrictEqual([handoff, "next question"]);
    });

    it("sends the handoff as a user message, not a system one", () => {
        expect(handoffMessage(handoff)).toMatchObject({ content: handoff, role: "user" });
    });

    it("sends identical handoff bytes at the same position on the first and the third turn after the switch", () => {
        const turn1 = [...history, switched, turn("u2", "user", "q1")];
        const turn3 = [...turn1, turn("a2", "assistant", "r1"), turn("u3", "user", "q2"), turn("a3", "assistant", "r2"), turn("u4", "user", "q3")];
        const first = contextTexts(turn1);
        const third = contextTexts(turn3);

        expect(first[0]).toBe(handoff);
        expect(third[0]).toBe(handoff);
        expect(Buffer.from(third[0]!).equals(Buffer.from(first[0]!))).toBe(true);
        expect(third.slice(1)).toStrictEqual(["q1", "r1", "q2", "r2", "q3"]);
    });

    it("leaves a full divider, or one with no handoff, as it was", () => {
        const full = divider("d1", { from: A, mode: "full", startMessageId: "a1", to: B });
        const { blocks, docs } = assembleHandoffContext([...history, full, ...after]);

        expect(blocks).toStrictEqual([]);
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u1", "a1", "u2"]);
    });

    it("uses the handoff of a divider older than the window when the window holds none", () => {
        const { blocks, docs } = assembleHandoffContext([turn("u9", "user", "late"), turn("a9", "assistant", "reply")], [handoff]);

        expect(blocks).toStrictEqual([{ before: 0, text: handoff }]);
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u9", "a9"]);
    });

    it("lets the newest handoff win after a second switch", () => {
        const second = handoffOf("a2");
        const { blocks, docs } = assembleHandoffContext([
            ...history,
            switched,
            turn("u2", "user", "q1"),
            turn("a2", "assistant", "r1"),
            divider("d2", { from: B, handoff: second, mode: "portable", startMessageId: "a2", to: A }),
            turn("u3", "user", "q2"),
        ]);

        expect(blocks).toStrictEqual([{ before: 0, text: second }]);
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u3"]);
    });
});

describe("switching back", () => {
    const delta = handoffOf("a2", "delta");
    const path = [
        turn("u1", "user", "hello"),
        turn("a1", "assistant", "hi"),
        divider("d1", { from: A, handoff: handoffOf("a1"), mode: "portable", startMessageId: "a1", to: B }),
        turn("u2", "user", "b question"),
        turn("a2", "assistant", "b answer"),
        divider("d2", { from: B, handoff: delta, mode: "delta", startMessageId: "a2", to: A }),
        turn("u3", "user", "back on a"),
    ];

    it("keeps what the model saw before it left and adds only what happened since", () => {
        const { blocks, docs } = assembleHandoffContext(path);

        // A saw u1, a1. B's rows are not repeated: the handoff carries them. Then the turns after the switch back.
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u1", "a1", "u3"]);
        expect(blocks).toStrictEqual([{ before: 2, text: delta }]);
        expect(textsOf(docs, blocks)).toStrictEqual(["hello", "hi", delta, "back on a"]);
    });

    it("stands in what the model saw when its earlier divider has left the window, instead of the delta alone", () => {
        const window = path.slice(3);
        const first = handoffOf("a1");

        expect(deltaOrphans(window)).toStrictEqual([{ id: "d2", model: A.model }]);

        const { blocks, docs } = assembleHandoffContext(window, [], new Map([[A.model, [first]]]));

        // A's first half stands in as the handoff of the divider it left through, then what A missed.
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u3"]);
        expect(blocks).toStrictEqual([
            { before: 0, text: first },
            { before: 0, text: delta },
        ]);
    });

    it("sends the same bytes on the turns before and after the divider it left through has slid out", () => {
        const first = handoffOf("a1");
        const bases = new Map([[A.model, [first]]]);
        const early = assembleHandoffContext(path.slice(3), [], bases);
        const later = assembleHandoffContext([...path.slice(6), turn("a3", "assistant", "r"), turn("u4", "user", "more")], [first, delta]);

        expect(textsOf(early.docs, early.blocks).slice(0, 2)).toStrictEqual([first, delta]);
        expect(textsOf(later.docs, later.blocks).slice(0, 2)).toStrictEqual([first, delta]);
    });

    it("needs no stand-in while the divider it left through is in the window", () => {
        expect(deltaOrphans(path)).toStrictEqual([]);
        expect(deltaOrphans(path.slice(2))).toStrictEqual([]);
    });

    it("looks for an earlier handoff unless the window holds a portable one", () => {
        expect(needsEarlierHandoff(path.slice(3))).toBe(true);
        expect(needsEarlierHandoff(path.slice(0, 4))).toBe(false);
        expect(needsEarlierHandoff(path.slice(0, 2))).toBe(true);
    });

    it("restores what the model saw, and adds no message, when nothing happened since it left", () => {
        const empty = divider("d2", { from: B, mode: "delta", startMessageId: "a1", to: A });
        const { blocks, docs } = assembleHandoffContext([path[0]!, path[1]!, path[2]!, empty, turn("u3", "user", "back on a")]);

        expect(docs.map((doc) => doc._id)).toStrictEqual(["u1", "a1", "u3"]);
        expect(blocks).toStrictEqual([]);
    });
});

describe("cache breakpoints", () => {
    const first = handoffOf("a1");
    const second = handoffOf("a2", "delta");

    it("puts the hint on the last handoff only, however many there are", () => {
        const messages = withHandoff([turn("u3", "user", "go on")] as never, [
            { before: 0, text: first },
            { before: 0, text: second },
        ]);
        const hinted = messages.filter((message) => message.providerOptions !== undefined);

        expect(messages.map((message) => message.content)).toStrictEqual([first, second, "go on"]);
        expect(hinted).toHaveLength(1);
        expect(hinted[0]!.content).toBe(second);
    });

    it("keeps a single handoff hinted, and a chain of switches back to three blocks at most one hinted", () => {
        const chain = assembleHandoffContext(
            [
                turn("u1", "user", "hello"),
                divider("d1", { from: A, handoff: first, mode: "portable", startMessageId: "u1", to: B }),
                turn("u2", "user", "b"),
                divider("d2", { from: B, handoff: second, mode: "delta", startMessageId: "u2", to: A }),
                turn("u3", "user", "a"),
                divider("d3", { from: A, handoff: handoffOf("u3", "delta"), mode: "delta", startMessageId: "u3", to: B }),
                turn("u4", "user", "b again"),
            ],
            [],
            new Map(),
        );
        const messages = withHandoff(chain.docs as never, chain.blocks);

        expect(chain.blocks.length).toBeGreaterThan(1);
        expect(messages.filter((message) => message.providerOptions !== undefined)).toHaveLength(1);
        expect(withHandoff([] as never, [{ before: 0, text: first }])[0]!.providerOptions).toBeDefined();
    });
});

describe("on a long thread", () => {
    it("puts a handoff inside the budget in front of the turns, and none of the old turns", () => {
        const fixture = longThreadFixture();
        const { older, tail } = planHandoff(fixture.toReversed());
        const handoff = composeHandoff({ kind: "portable", summary: "summary", tail });
        const old = fixture.map((entry, index) => turn(`r${index}`, entry.role, entry.text));
        const { blocks, docs } = assembleHandoffContext([
            ...old,
            divider("d1", { from: A, handoff, mode: "portable", startMessageId: "r299", to: B }),
            turn("u", "user", "go on"),
        ]);

        expect(older.length).toBeGreaterThan(0);
        expect(docs.map((doc) => doc._id)).toStrictEqual(["u"]);
        expect(blocks).toStrictEqual([{ before: 0, text: handoff }]);
    });
});
