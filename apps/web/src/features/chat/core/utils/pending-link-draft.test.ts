import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { savePendingLinkDraft, takePendingLinkDraft } from "./pending-link-draft";

const NOW = 1_000_000;

describe("a linked draft kept for a sign-in", () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it("is taken by a different account, once, with its model", () => {
        savePendingLinkDraft({ model: "gpt-4o", prompt: "from the link" }, null, NOW);

        expect(takePendingLinkDraft("account-1", NOW)).toEqual({ model: "gpt-4o", prompt: "from the link" });
        expect(takePendingLinkDraft("account-1", NOW)).toBeUndefined();
    });

    it("is not taken by the same account opening a chat again, so it waits for a sign-in", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "guest-1", NOW);

        expect(takePendingLinkDraft("guest-1", NOW)).toBeUndefined();
        expect(takePendingLinkDraft("account-1", NOW)).toEqual({ prompt: "from the link" });
    });

    it("is not taken once it is older than the sign-in can take a while", () => {
        savePendingLinkDraft({ prompt: "from the link" }, null, NOW);

        expect(takePendingLinkDraft("account-1", NOW + 31 * 60 * 1000)).toBeUndefined();
        expect(sessionStorage.getItem("neore.pendingLinkDraft")).toBeNull();
    });

    it("ignores a stored value it cannot read, and removes it", () => {
        sessionStorage.setItem("neore.pendingLinkDraft", "{not json");

        expect(takePendingLinkDraft("account-1", NOW)).toBeUndefined();
        expect(sessionStorage.getItem("neore.pendingLinkDraft")).toBeNull();
    });

    it("ignores a stored value with no prompt", () => {
        sessionStorage.setItem("neore.pendingLinkDraft", JSON.stringify({ prompt: "", savedAt: NOW, userId: null }));

        expect(takePendingLinkDraft("account-1", NOW)).toBeUndefined();
    });
});
