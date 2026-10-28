import { describe, expect, it } from "vitest";

import { MAX_IMPORT_TEXT_CHARS, MAX_IMPORTED_TURNS, ReplayCollector } from "./replay";

const ID = "native-1";
const text = (value: string) => {
    return { text: value, type: "text" };
};
const say = (collector: ReplayCollector, sessionUpdate: string, content: unknown, extra: Record<string, unknown> = {}, sessionId = ID) =>
    collector.update({ sessionId, update: { content, sessionUpdate, ...extra } });

describe("ReplayCollector", () => {
    it("makes a turn of each user message and the agent's words that follow", () => {
        const collector = new ReplayCollector(ID);

        say(collector, "user_message_chunk", text("fix the "));
        say(collector, "user_message_chunk", text("bug"));
        say(collector, "agent_thought_chunk", text("hm"));
        say(collector, "agent_message_chunk", text("Done"));
        say(collector, "agent_message_chunk", text("."));
        say(collector, "user_message_chunk", text("and the tests"));
        say(collector, "agent_message_chunk", text("Too."));

        expect(collector.result().turns).toEqual([
            { reasoning: "hm", text: "Done.", user: "fix the bug" },
            { reasoning: "", text: "Too.", user: "and the tests" },
        ]);
    });

    it("starts a turn for a user message with a new id, and keeps a turn that opens with the agent", () => {
        const collector = new ReplayCollector(ID);

        say(collector, "agent_message_chunk", text("Welcome"));
        say(collector, "user_message_chunk", text("one"), { messageId: "m1" });
        say(collector, "user_message_chunk", text(" more"), { messageId: "m1" });
        say(collector, "user_message_chunk", text("two"), { messageId: "m2" });

        expect(collector.result().turns).toEqual([
            { reasoning: "", text: "Welcome", user: "" },
            { reasoning: "", text: "", user: "one more" },
            { reasoning: "", text: "", user: "two" },
        ]);
    });

    it("ignores tool calls, other sessions' updates and anything it does not know", () => {
        const collector = new ReplayCollector(ID);

        say(collector, "user_message_chunk", text("hi"));
        collector.update({ sessionId: ID, update: { sessionUpdate: "tool_call", title: "Read" } });
        collector.update({ sessionId: ID, update: { entries: [], sessionUpdate: "plan" } });
        say(collector, "agent_message_chunk", text("elsewhere"), {}, "other");
        collector.update("nonsense");
        collector.update({ sessionId: ID });

        expect(collector.result().turns).toEqual([{ reasoning: "", text: "", user: "hi" }]);
    });

    it("shows a block that is not text as its type", () => {
        const collector = new ReplayCollector(ID);

        say(collector, "user_message_chunk", { data: "AAAA", mimeType: "image/png", type: "image" });

        expect(collector.result().turns[0]?.user).toBe("[image]");
    });

    it("masks the values the user asked to hide, also when they straddle two chunks", () => {
        const collector = new ReplayCollector(ID, (value) => value.replaceAll("sekrit", "••••"));

        say(collector, "user_message_chunk", text("my key is sek"));
        say(collector, "user_message_chunk", text("rit ok"));

        expect(collector.result().turns[0]?.user).toBe("my key is •••• ok");
    });

    it("cuts a field to the backend's limit, masked first, and says how many turns it shortened", () => {
        const collector = new ReplayCollector(ID, (value) => value.replaceAll("sekrit", "••••"));

        say(collector, "user_message_chunk", text("hi"));
        say(collector, "agent_message_chunk", text("a".repeat(MAX_IMPORT_TEXT_CHARS - 3)));
        say(collector, "agent_message_chunk", text("sekrit"));
        say(collector, "agent_message_chunk", text("more"));

        const { shortenedTurns, turns } = collector.result();

        expect(turns[0]?.text).toHaveLength(MAX_IMPORT_TEXT_CHARS);
        expect(turns[0]?.text.endsWith("•••")).toBe(true);
        expect(shortenedTurns).toBe(1);
    });

    it("keeps the first turns past the cap and counts the rest", () => {
        const collector = new ReplayCollector(ID);

        for (let index = 0; index < MAX_IMPORTED_TURNS + 3; index += 1) {
            say(collector, "user_message_chunk", text(`q${String(index)}`));
            say(collector, "agent_message_chunk", text("a"));
        }

        const { droppedTurns, turns } = collector.result();

        expect(turns).toHaveLength(MAX_IMPORTED_TURNS);
        expect(turns.at(-1)?.user).toBe(`q${String(MAX_IMPORTED_TURNS - 1)}`);
        expect(droppedTurns).toBe(3);
    });

    it("drops a turn with nothing in it", () => {
        const collector = new ReplayCollector(ID);

        say(collector, "user_message_chunk", text("  "));
        say(collector, "agent_message_chunk", text(""));

        expect(collector.result().turns).toEqual([]);
    });
});
