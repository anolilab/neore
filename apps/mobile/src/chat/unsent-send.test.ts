import { describe, expect, it } from "vitest";

import { ChatError } from "./chat-api";
import type { SendStage } from "./unsent-send";
import {
    failedSendMessage,
    failedSendOutcome,
    MAY_HAVE_BEEN_SENT_NOTICE,
    shouldKeepClientMessageId,
    STILL_SENDING_MESSAGE,
    withoutUnsentRows,
} from "./unsent-send";

describe("a send the server never accepted", () => {
    it("drops only its own local rows", () => {
        const rows = [{ id: "saved" }, { id: "user-1" }, { id: "pending-1" }];

        expect(withoutUnsentRows(rows, ["user-1", "pending-1"])).toStrictEqual([{ id: "saved" }]);
    });
});

describe(failedSendOutcome, () => {
    // Every send the server did not answer with a started chat keeps its prompt as a returned prompt: none is retried later
    // by the app, and resending it under the same `clientMessageId` cannot save it twice.
    it.each<[string, SendStage, ReturnType<typeof failedSendOutcome>]>([
        ["a token or offline failure before the request", "before-request", "keep"],
        ["a refusal, a timeout, a dropped connection or a 5xx after the request went out", "requested", "keep"],
        ["a reply that failed after the start", "accepted", "accepted"],
    ])("%s", (_name, stage, expected) => {
        expect(failedSendOutcome(stage)).toBe(expected);
    });
});

describe(shouldKeepClientMessageId, () => {
    it("keeps the id of a kept prompt, so its resend is the same send", () => {
        expect(shouldKeepClientMessageId(new ChatError("The gateway did not answer in time."))).toBe(true);
        expect(shouldKeepClientMessageId(new TypeError("Network request failed"))).toBe(true);
        expect(shouldKeepClientMessageId(new ChatError("Rate limited", { isRefusal: true }))).toBe(true);
    });

    it("drops an id the server says belongs to a different request", () => {
        expect(shouldKeepClientMessageId(new ChatError("Used for another message", { code: "client_message_id_reused", isRefusal: true }))).toBe(false);
    });
});

describe(failedSendMessage, () => {
    it("says a send that may have reached the server is safe to resend", () => {
        expect(failedSendMessage(new ChatError("The gateway did not answer in time."), "requested")).toBe(
            `The gateway did not answer in time. ${MAY_HAVE_BEEN_SENT_NOTICE}`,
        );
    });

    it("shows a refusal, and a failure before the request, as they are", () => {
        expect(failedSendMessage(new ChatError("Rate limited", { isRefusal: true }), "requested")).toBe("Rate limited");
        expect(failedSendMessage(new ChatError("Your sign-in expired."), "before-request")).toBe("Your sign-in expired.");
    });

    it("does not call a send still being saved a failure", () => {
        expect(failedSendMessage(new ChatError("This message is still being sent.", { code: "chat_start_in_progress" }), "requested")).toBe(STILL_SENDING_MESSAGE);
    });
});
