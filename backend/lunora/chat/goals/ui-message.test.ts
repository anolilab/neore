import { describe, expect, it } from "vitest";

import { toUIMessages } from "../../agent/ui-messages";
import { GOAL_CONTINUATION_AGENT } from "./shared";

describe("a goal's instruction row in the thread's messages", () => {
    it("keeps its marker, so the thread can hide it", () => {
        const base = { _creationTime: 1, status: "success", threadId: "t1", tool: false };
        const [instruction, reply] = toUIMessages([
            {
                ...base,
                _id: "m1",
                agentName: GOAL_CONTINUATION_AGENT,
                message: { content: [{ text: "Goal: ship it", type: "text" }], role: "user" },
                order: 1,
                stepOrder: 0,
                text: "Goal: ship it",
            },
            { ...base, _id: "m2", message: { content: [{ text: "Done.", type: "text" }], role: "assistant" }, order: 1, stepOrder: 1, text: "Done." },
        ] as never);

        expect(instruction).toMatchObject({ agentName: GOAL_CONTINUATION_AGENT, id: "m1", role: "user" });
        expect(reply?.agentName).toBeUndefined();
    });
});
