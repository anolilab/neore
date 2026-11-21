import { describe, expect, it } from "vitest";

import type { AccountPanel } from "./account-panel";
import { panelFor } from "./account-panel";

const chatOf = (userId: string): AccountPanel => {
    return {
        activeOrgId: "org-1",
        userId,
        view: { key: "view-1", seed: { autoSend: "Translate", id: "seed-1" }, threadId: "thread-1", type: "chat" },
    };
};

describe(panelFor, () => {
    it("drops another account's chat, seed and organization", () => {
        expect(panelFor(chatOf("u1"), "u2")).toEqual({ activeOrgId: null, userId: "u2", view: { type: "threads" } });
    });

    it("keeps the same account's chat, whatever the grant", () => {
        const panel = chatOf("u1");

        expect(panelFor(panel, "u1")).toBe(panel);
    });
});
