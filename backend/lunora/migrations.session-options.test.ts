import { describe, expect, it } from "vitest";

import { dropAgentOptionFields, sessionOptionsToSessionState } from "./migrations";
import { vHostEvent } from "./acp/validators";

const CREATED = 1_700_000_000_000;
const option = { category: "model", choices: [{ name: "Deep", value: "deep" }], currentValue: "deep", id: "model", name: "Model" };

describe("dropAgentOptionFields", () => {
    const up = dropAgentOptionFields.up as unknown as (document: unknown) => Record<string, unknown>;

    it("keeps a row's agent options as its agent state, dated by when they were reported, and drops the legacy fields", () => {
        const migrated = up({
            _id: "s1",
            agentOptions: { configOptions: [option], modes: { available: [{ name: "Ask", value: "ask" }], current: "ask" } },
            agentOptionsAt: 1234,
            threadId: "t1",
        });

        expect(migrated).toMatchObject({
            _id: "s1",
            agentState: { configOptions: [option], modes: { available: [{ id: "ask", name: "Ask" }], current: "ask" } },
            agentStateAt: 1234,
            threadId: "t1",
        });
        expect(migrated).not.toHaveProperty("agentOptions");
        expect(migrated).not.toHaveProperty("agentOptionsAt");
    });

    it("keeps the agent state a row already has, and drops only the legacy fields", () => {
        const agentState = { usage: { size: 100, used: 10 } };
        const migrated = up({ _id: "s2", agentOptions: { configOptions: [option] }, agentOptionsAt: 1, agentState, agentStateAt: 9, threadId: "t2" });

        expect(migrated).toMatchObject({ agentState, agentStateAt: 9 });
        expect(migrated).not.toHaveProperty("agentOptions");
    });

    it("fills the options a usage-only agent state lacks from the legacy fields, and keeps the fields the state reports, empty lists included", () => {
        const migrated = up({
            _id: "s4",
            agentOptions: { configOptions: [option], modes: { available: [{ name: "Ask", value: "ask" }], current: "ask" } },
            agentOptionsAt: 1,
            agentState: { usage: { size: 100, used: 10 } },
            agentStateAt: 9,
            threadId: "t4",
        });

        expect(migrated).toMatchObject({
            agentState: { configOptions: [option], modes: { available: [{ id: "ask", name: "Ask" }], current: "ask" }, usage: { size: 100, used: 10 } },
            agentStateAt: 9,
        });

        const reported = up({ _id: "s5", agentOptions: { configOptions: [option] }, agentState: { configOptions: [] }, threadId: "t5" });

        expect(reported).toMatchObject({ agentState: { configOptions: [] } });
    });

    it("leaves a row without legacy options as it is, apart from the fields the schema no longer declares", () => {
        expect(up({ _id: "s3", threadId: "t3" })).toEqual({ _id: "s3", threadId: "t3" });
    });
});

describe("sessionOptionsToSessionState", () => {
    it("converts a stored session_options chunk to a session_state event with the same options", () => {
        const row = {
            _creationTime: CREATED,
            _id: "chunk1",
            event: { kind: "session_options", options: { configOptions: [option], modes: { available: [{ name: "Ask", value: "ask" }], current: "ask" } } },
            seq: 4,
            streamId: "s1",
        };

        const up = sessionOptionsToSessionState.up as unknown as (document: unknown) => Record<string, unknown> | undefined;
        const converted = up(row);

        expect(converted).toMatchObject({ _id: "chunk1", seq: 4, streamId: "s1" });
        expect(converted?.event).toEqual({
            at: CREATED,
            configOptions: [option],
            kind: "session_state",
            modes: { available: [{ id: "ask", name: "Ask" }], current: "ask" },
        });
    });

    it("leaves every other chunk untouched", () => {
        const up = sessionOptionsToSessionState.up as unknown as (document: unknown) => unknown;

        expect(up({ _creationTime: CREATED, event: { kind: "tool_call" } })).toBeUndefined();
        expect(up({ _creationTime: CREATED, text: "hi" })).toBeUndefined();
    });

    it("produces an event the current host event schema accepts, and the schema no longer takes the old kind", () => {
        const up = sessionOptionsToSessionState.up as unknown as (document: unknown) => { event: unknown } | undefined;
        const converted = up({ _creationTime: CREATED, event: { kind: "session_options", options: { configOptions: [option] } } });

        expect(vHostEvent.safeParse(converted?.event).ok).toBe(true);
        expect(vHostEvent.safeParse({ kind: "session_options", options: { configOptions: [option] } }).ok).toBe(false);
    });
});
