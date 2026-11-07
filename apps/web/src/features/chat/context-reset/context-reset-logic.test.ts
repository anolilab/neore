import { describe, expect, it } from "vitest";

import { clearRefusalOf, clearsDraftAfterReset, isClearCommand } from "./context-reset-logic";

describe(isClearCommand, () => {
    it("is the `/clear` command, whatever the case and surrounding space", () => {
        expect.assertions(3);

        expect(isClearCommand("/clear")).toBe(true);
        expect(isClearCommand("  /CLEAR  ")).toBe(true);
        expect(isClearCommand("/clear\n")).toBe(true);
    });

    it("is not a message that mentions it or a different command", () => {
        expect.assertions(3);

        expect(isClearCommand("please /clear this")).toBe(false);
        expect(isClearCommand("/clearly")).toBe(false);
        expect(isClearCommand("/compact")).toBe(false);
    });
});

describe(clearRefusalOf, () => {
    it.each([
        [{ data: { code: "FORBIDDEN" } }, "not_owner"],
        [{ data: { code: "CONFLICT" } }, "busy"],
        [{ code: "BAD_REQUEST" }, "unavailable"],
        [{ data: { code: "TOO_MANY_REQUESTS" } }, "rate_limited"],
        [{ code: "CONFLICT", data: { code: "CONTEXT_CLEAR_AGENT_STARTING" } }, "agent_starting"],
        [{ code: "CONFLICT", data: { code: "CONTEXT_CLEAR_ALREADY_MADE" } }, "already_made"],
        [{ code: "CONFLICT", data: { code: "CONTEXT_CLEAR_REPLY_RUNNING" } }, "busy"],
        [new Error("offline"), "failed"],
        [undefined, "failed"],
    ])("reads %o as %s", (error, refusal) => {
        expect.assertions(1);

        expect(clearRefusalOf(error)).toBe(refusal);
    });
});

describe(clearsDraftAfterReset, () => {
    const state = { currentThreadId: "a", draft: "/clear", mounted: true, startedThreadId: "a" };

    it("removes the command from the composer the clear was sent from", () => {
        expect.assertions(1);

        expect(clearsDraftAfterReset(state)).toBe(true);
    });

    it("leaves another chat's draft, an unmounted composer and an edited draft alone", () => {
        expect.assertions(3);

        expect(clearsDraftAfterReset({ ...state, currentThreadId: "b" })).toBe(false);
        expect(clearsDraftAfterReset({ ...state, mounted: false })).toBe(false);
        expect(clearsDraftAfterReset({ ...state, draft: "/clear and more" })).toBe(false);
    });
});
