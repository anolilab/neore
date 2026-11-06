import { describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "../../_generated/server";
import { readPermissionCap, readRequestPermissionCap, readRunPermissionCap } from "./run-permission-cap";

const fakeCtx = (runQuery: ReturnType<typeof vi.fn>) => ({ runQuery }) as unknown as Pick<ActionCtx, "runQuery">;

describe("readPermissionCap", () => {
    it("gives auto for the personal space and reads nothing", async () => {
        const runQuery = vi.fn();

        expect(await readPermissionCap(fakeCtx(runQuery), null)).toBe("auto");
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("returns the organization's cap from its policy", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce("ask");

        expect(await readPermissionCap(fakeCtx(runQuery), "org_a")).toBe("ask");
        expect(runQuery).toHaveBeenCalledWith(expect.anything(), { organizationId: "org_a" });
    });

    it("caps at ask when the policy read throws, never dropping the cap", async () => {
        const runQuery = vi.fn().mockRejectedValueOnce(new Error("database unavailable"));

        expect(await readPermissionCap(fakeCtx(runQuery), "org_a")).toBe("ask");
    });
});

describe("readRunPermissionCap", () => {
    it("takes the organization the caller names when the run has no thread", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce("off");

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: "org_b", threadId: undefined })).toBe("off");
        expect(runQuery).toHaveBeenCalledTimes(1);
        expect(runQuery).toHaveBeenCalledWith(expect.anything(), { organizationId: "org_b" });
    });

    it("takes the thread's organization over the one the caller passes", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: "org_thread" }).mockResolvedValueOnce("ask");

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: "org_other", threadId: "thread_1" })).toBe("ask");
        expect(runQuery).toHaveBeenLastCalledWith(expect.anything(), { organizationId: "org_thread" });
    });

    it("takes the run's organization for a thread that has none stored, so it is capped, not uncapped", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: null }).mockResolvedValueOnce("off");

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: "org_other", threadId: "thread_1" })).toBe("off");
        expect(runQuery).toHaveBeenLastCalledWith(expect.anything(), { organizationId: "org_other" });
    });

    it("gives auto for a thread and a run with no organization", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: undefined });

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: null, threadId: "thread_1" })).toBe("auto");
        expect(runQuery).toHaveBeenCalledTimes(1);
    });

    it("caps at ask when the thread does not exist, instead of falling back to auto", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce(null);

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: null, threadId: "thread_missing" })).toBe("ask");
        expect(runQuery).toHaveBeenCalledTimes(1);
    });

    it("caps at ask when the thread read throws", async () => {
        const runQuery = vi.fn().mockRejectedValueOnce(new Error("thread read failed"));

        expect(await readRunPermissionCap(fakeCtx(runQuery), { organizationId: null, threadId: "thread_1" })).toBe("ask");
    });
});

describe("readRequestPermissionCap", () => {
    // An HTTP action's identity carries `orgId` and no session id.
    const requestCtx = (identity: { orgId?: string; userId: string } | null, runQuery: ReturnType<typeof vi.fn>) =>
        ({ auth: { getIdentity: async () => identity }, runQuery }) as never;

    it("caps by the organization claim of the identity, with no session id", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce("ask");

        expect(await readRequestPermissionCap(requestCtx({ orgId: "org_a", userId: "user_1" }, runQuery))).toBe("ask");
        expect(runQuery).toHaveBeenCalledTimes(1);
        expect(runQuery).toHaveBeenCalledWith(expect.anything(), { organizationId: "org_a" });
    });

    it("gives auto without an organization claim, which is the personal space", async () => {
        const runQuery = vi.fn();

        expect(await readRequestPermissionCap(requestCtx({ userId: "user_1" }, runQuery))).toBe("auto");
        expect(await readRequestPermissionCap(requestCtx(null, runQuery))).toBe("auto");
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("caps at ask when the policy read throws", async () => {
        const runQuery = vi.fn().mockRejectedValueOnce(new Error("policy read failed"));

        expect(await readRequestPermissionCap(requestCtx({ orgId: "org_a", userId: "user_1" }, runQuery))).toBe("ask");
    });
});
