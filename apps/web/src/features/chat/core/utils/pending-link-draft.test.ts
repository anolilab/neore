import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearPendingLinkDraft, prunePendingLinkDraft, savePendingLinkDraft, takePendingLinkDraft } from "./pending-link-draft";

const KEY = "neore.pendingLinkDraft";
const NOW = 1_000_000;
const THIRTY_ONE_MINUTES = 31 * 60 * 1000;

describe("a linked draft kept for a visit", () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it("is taken by the account it was saved for, once", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "account-a", NOW);

        expect(takePendingLinkDraft("account-a", NOW)).toEqual({ prompt: "from the link" });
        expect(takePendingLinkDraft("account-a", NOW)).toBeUndefined();
    });

    it("saved for account A is not applied to account B, and is removed", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "account-a", NOW);

        expect(takePendingLinkDraft("account-b", NOW)).toBeUndefined();
        expect(sessionStorage.getItem(KEY)).toBeNull();
        expect(takePendingLinkDraft("account-a", NOW)).toBeUndefined();
    });

    it("saved while signed out is not applied to a signed-in account", () => {
        savePendingLinkDraft({ prompt: "from the link" }, null, NOW);

        expect(takePendingLinkDraft("account-a", NOW)).toBeUndefined();
        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it("is removed when it is older than the limit, on read, and gives nothing", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "account-a", NOW);

        expect(takePendingLinkDraft("account-a", NOW + THIRTY_ONE_MINUTES)).toBeUndefined();
        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it("is removed when it is older than the limit, when the chat page mounts, without being read", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "account-a", NOW);

        prunePendingLinkDraft(NOW + THIRTY_ONE_MINUTES);

        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it("keeps a draft that is still within the limit when the page mounts", () => {
        savePendingLinkDraft({ prompt: "from the link" }, "account-a", NOW);

        prunePendingLinkDraft(NOW + 1000);

        expect(takePendingLinkDraft("account-a", NOW + 1000)).toEqual({ prompt: "from the link" });
    });

    it("ignores a stored value it cannot read, and removes it", () => {
        sessionStorage.setItem(KEY, "{not json");

        expect(takePendingLinkDraft("account-a", NOW)).toBeUndefined();
        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it("ignores a stored value with no prompt, and removes it when the page mounts", () => {
        sessionStorage.setItem(KEY, JSON.stringify({ prompt: "", savedAt: NOW, userId: null }));

        prunePendingLinkDraft(NOW);

        expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it("is removed when the composer is cleared, so a sent draft is not restored again", () => {
        savePendingLinkDraft({ prompt: "from the link" }, null, NOW);

        clearPendingLinkDraft();

        expect(takePendingLinkDraft(null, NOW)).toBeUndefined();
    });
});
