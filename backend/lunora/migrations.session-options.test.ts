import { describe, expect, it } from "vitest";

import { sessionOptionsToSessionState } from "./migrations";
import { vHostEvent } from "./acp/validators";

const CREATED = 1_700_000_000_000;
const option = { category: "model", choices: [{ name: "Deep", value: "deep" }], currentValue: "deep", id: "model", name: "Model" };

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
