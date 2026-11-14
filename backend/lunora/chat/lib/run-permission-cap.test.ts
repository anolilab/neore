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

    it("keeps a temporary chat's starting organization over the space a later turn is sent from", async () => {
        // A temporary chat is never filed under its organization, so a turn sent later from the personal space (no run
        // organization) or from another organization must still read the one it was started in.
        const fromPersonal = vi.fn().mockResolvedValueOnce({ capOrganizationId: "org_started" }).mockResolvedValueOnce("off");
        const fromOther = vi.fn().mockResolvedValueOnce({ capOrganizationId: "org_started" }).mockResolvedValueOnce("off");

        expect(await readRunPermissionCap(fakeCtx(fromPersonal), { organizationId: null, threadId: "thread_1" })).toBe("off");
        expect(fromPersonal).toHaveBeenNthCalledWith(2, expect.anything(), { organizationId: "org_started" });
        expect(await readRunPermissionCap(fakeCtx(fromOther), { organizationId: "org_other", threadId: "thread_1" })).toBe("off");
        expect(fromOther).toHaveBeenNthCalledWith(2, expect.anything(), { organizationId: "org_started" });
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
    const requestCtx = (sessionId: string | undefined, runQuery: ReturnType<typeof vi.fn>) =>
        ({ auth: { getIdentity: async () => (sessionId === undefined ? null : { sessionId }) }, runQuery }) as never;

    it("reads the active organization from the caller's session and caps by it", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: "org_a" }).mockResolvedValueOnce("ask");

        expect(await readRequestPermissionCap(requestCtx("session_1", runQuery), "user_1")).toStrictEqual({ cap: "ask" });
        expect(runQuery).toHaveBeenNthCalledWith(1, expect.anything(), { sessionId: "session_1", userId: "user_1" });
        expect(runQuery).toHaveBeenNthCalledWith(2, expect.anything(), { organizationId: "org_a" });
    });

    it("caps at ask when the named session is gone, expired or another user's", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce(null);

        expect(await readRequestPermissionCap(requestCtx("session_stale", runQuery), "user_1")).toStrictEqual({ cap: "ask", unresolved: "session" });
        expect(runQuery).toHaveBeenCalledTimes(1);
    });

    it("reads an app grant's sign-in, as the extension, desktop and phone carry it, and caps by its organization", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: "org_a" }).mockResolvedValueOnce("ask");
        const context = {
            auth: {
                getIdentity: async () => {
                    return { grantSessionId: "grant_session_1", userId: "user_1" };
                },
            },
            runQuery,
        } as never;

        expect(await readRequestPermissionCap(context, "user_1")).toStrictEqual({ cap: "ask" });
        expect(runQuery).toHaveBeenNthCalledWith(1, expect.anything(), { sessionId: "grant_session_1", userId: "user_1" });
    });

    it("gives auto for a valid session in the personal space", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: null });

        expect(await readRequestPermissionCap(requestCtx("session_1", runQuery), "user_1")).toStrictEqual({ cap: "auto" });
        expect(runQuery).toHaveBeenCalledTimes(1);
    });

    it("caps at ask for a signed-in identity that names no session, since its space cannot be told", async () => {
        const runQuery = vi.fn();
        const context = {
            auth: {
                getIdentity: async () => {
                    return { userId: "user_1" };
                },
            },
            runQuery,
        } as never;

        expect(await readRequestPermissionCap(context, "user_1")).toStrictEqual({ cap: "ask", unresolved: "session" });
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("caps at ask when a signed-in caller's identity is missing, instead of reading it as the personal space", async () => {
        const runQuery = vi.fn();

        expect(await readRequestPermissionCap(requestCtx(undefined, runQuery), "user_1")).toStrictEqual({ cap: "ask", unresolved: "session" });
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("reports a failed policy read as unavailable, not as the organization's own ask", async () => {
        const runQuery = vi.fn().mockResolvedValueOnce({ organizationId: "org_a" }).mockRejectedValueOnce(new Error("policy read failed"));

        expect(await readRequestPermissionCap(requestCtx("session_1", runQuery), "user_1")).toStrictEqual({ cap: "ask", unresolved: "unavailable" });
    });

    it("caps at ask when the session lookup throws", async () => {
        const runQuery = vi.fn().mockRejectedValueOnce(new Error("session read failed"));

        expect(await readRequestPermissionCap(requestCtx("session_1", runQuery), "user_1")).toStrictEqual({ cap: "ask", unresolved: "unavailable" });
    });
});
