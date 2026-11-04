import { describe, expect, it } from "vitest";

import { replyStateAfter } from "./reply-state";

const message = (id: string, role: string, status = "success") => {
    return { id, role, status };
};

describe("replyStateAfter", () => {
    it("is unknown while the send is not on the pages read", () => {
        expect(replyStateAfter([message("reply", "assistant")], "sent")).toBe("unknown");
    });

    it("is pending while the send has no reply yet", () => {
        expect(replyStateAfter([message("sent", "user")], "sent")).toBe("pending");
    });

    it("is settled when the reply after the send has a final status", () => {
        const newestFirst = [message("reply", "assistant", "success"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("settled");
    });

    it("is pending while the reply after the send is still streaming", () => {
        const newestFirst = [message("reply", "assistant", "pending"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("pending");
    });

    it("counts a failed reply as final", () => {
        const newestFirst = [message("reply", "assistant", "failed"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("settled");
    });

    it("ignores an older settled reply, which is below the send in the list", () => {
        const newestFirst = [message("sent", "user"), message("oldReply", "assistant", "success")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("pending");
    });

    it("judges the newest step of the reply, so a settled earlier step does not end a reply still running", () => {
        const newestFirst = [message("step2", "assistant", "pending"), message("step1", "assistant", "success"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("pending");
    });

    it("does not take another session's completed reply to a newer turn as this send's reply", () => {
        const newestFirst = [message("otherReply", "assistant", "success"), message("otherUser", "user"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("pending");
    });

    it("reads this send's reply when another session's turn sits above it", () => {
        const pending = [message("otherReply", "assistant", "success"), message("otherUser", "user"), message("ours", "assistant", "pending"), message("sent", "user")];
        const settled = [message("otherReply", "assistant", "success"), message("otherUser", "user"), message("ours", "assistant", "success"), message("sent", "user")];

        expect(replyStateAfter(pending, "sent")).toBe("pending");
        expect(replyStateAfter(settled, "sent")).toBe("settled");
    });
});
