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

    it("judges the newest reply, so a settled earlier step does not end a reply still running", () => {
        const newestFirst = [message("step2", "assistant", "pending"), message("step1", "assistant", "success"), message("sent", "user")];

        expect(replyStateAfter(newestFirst, "sent")).toBe("pending");
    });
});
