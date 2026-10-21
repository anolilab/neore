import { describe, expect, it } from "vitest";

import { CANCELLED_IMPORT_MESSAGE, isRestartable, keptImportKeyFor } from "./restart";

describe("isRestartable", () => {
    const failed = {
        errorMessage: "boom",
        failedConversations: 1,
        importedConversations: 3,
        r2Key: "chat-import/u1/j1",
        status: "failed" as const,
        totalConversations: 5,
    };

    it("allows a failed import that still holds its file and has conversations left", () => {
        expect(isRestartable(failed)).toBe(true);
    });

    it("refuses a failed import with every conversation already saved or counted as failed", () => {
        expect(isRestartable({ ...failed, failedConversations: 2, importedConversations: 3 })).toBe(false);
    });

    it("allows a failed run that stopped before any conversation was counted", () => {
        expect(isRestartable({ ...failed, failedConversations: 0, importedConversations: 0 })).toBe(true);
    });

    it("refuses a cancelled import, whatever its file", () => {
        expect(isRestartable({ ...failed, errorMessage: CANCELLED_IMPORT_MESSAGE })).toBe(false);
    });

    it("refuses a job whose file was not kept (older failed jobs hold an empty key)", () => {
        expect(isRestartable({ ...failed, r2Key: "" })).toBe(false);
        expect(isRestartable({ ...failed, r2Key: undefined })).toBe(false);
    });

    it("refuses a job that is not failed", () => {
        expect(isRestartable({ ...failed, status: "processing" })).toBe(false);
        expect(isRestartable({ ...failed, status: "completed" })).toBe(false);
    });
});

describe("keptImportKeyFor", () => {
    it("keys the kept copy per user and job, outside the staging prefix the reap deletes", () => {
        expect(keptImportKeyFor("u1", "j1")).toBe("chat-import/u1/j1");
        expect(keptImportKeyFor("u1", "j1").startsWith("uploads/")).toBe(false);
    });
});
