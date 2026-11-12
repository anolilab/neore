import { describe, expect, it } from "vitest";

import { ChatError } from "./chat-api";
import { draftAfterUnsent, failedSendOutcome, withoutUnsentRows } from "./unsent-send";

describe("a send the server never accepted", () => {
    it("puts the prompt back in an empty composer", () => {
        expect(draftAfterUnsent("", "hello")).toBe("hello");
        expect(draftAfterUnsent("  ", "hello")).toBe("hello");
    });

    it("keeps what was typed since, after the prompt", () => {
        expect(draftAfterUnsent("and more", "hello")).toBe("hello\n\nand more");
    });

    it("drops only its own local rows", () => {
        const rows = [{ id: "saved" }, { id: "user-1" }, { id: "pending-1" }];

        expect(withoutUnsentRows(rows, ["user-1", "pending-1"])).toStrictEqual([{ id: "saved" }]);
    });
});

describe(failedSendOutcome, () => {
    it.each<[string, Parameters<typeof failedSendOutcome>[0], unknown, ReturnType<typeof failedSendOutcome>]>([
        ["a token or offline failure before the request", "before-request", new ChatError("Your sign-in expired."), "give-back"],
        ["a refusal the gateway answered", "requested", new ChatError("Rate limited", { isRefusal: true }), "give-back"],
        ["a timeout after the request went out", "requested", new ChatError("The gateway did not answer in time."), "possibly-sent"],
        ["a connection dropped mid-response", "requested", new TypeError("Network request failed"), "possibly-sent"],
        ["a 2xx body that would not parse", "requested", new SyntaxError("Unexpected end of JSON input"), "possibly-sent"],
        ["a reply that failed after the start", "accepted", new ChatError("The reply did not finish."), "accepted"],
    ])("%s", (_name, stage, error, expected) => {
        expect(failedSendOutcome(stage, error)).toBe(expected);
    });
});
