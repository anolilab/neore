/** An answer counts as the owner's only from a live, unmarked session of their own; anything else marks it. */
import { describe, expect, it } from "vitest";

import { callerSessionMarks, callerSessionNotOwn } from "./caller-session";

const NOW = 1_000_000;
const OWNER = "user-owner";

type SessionRow = { clientGrant?: string; expiresAt: number; impersonatedBy?: string; userId: string };

const contextWith = (options: {
    identity?: { grantSessionId?: string; sessionId?: string; userId?: string } | null;
    impersonatedBy?: string | null;
    read?: () => Promise<SessionRow | null>;
    session?: SessionRow | null;
}) =>
    ({
        auth: { getIdentity: async () => options.identity ?? null },
        db: { session: { findFirst: options.read ?? (async () => options.session ?? null) } },
        now: NOW,
        user: { impersonatedBy: options.impersonatedBy ?? null, userId: OWNER },
    }) as never;

const liveSession = { expiresAt: NOW + 60_000, userId: OWNER };

describe("callerSessionNotOwn", () => {
    it("reads the owner's own live session, and their desktop and phone apps' grants, as theirs", async () => {
        await expect(callerSessionNotOwn(contextWith({ identity: { sessionId: "s1" }, session: liveSession }))).resolves.toBe(false);

        for (const clientGrant of ["desktop", "mobile"]) {
            await expect(callerSessionNotOwn(contextWith({ identity: { grantSessionId: "g1" }, session: { ...liveSession, clientGrant } }))).resolves.toBe(
                false,
            );
        }
    });

    it.each([
        ["a browser extension's grant", "extension"],
        ["a grant whose app was never recorded", undefined],
        ["a grant naming an app nobody classified", "watch"],
    ])("marks what %s sends as the extension's", async (_name, clientGrant) => {
        const context = contextWith({ identity: { grantSessionId: "g1" }, session: { ...liveSession, ...(clientGrant !== undefined && { clientGrant }) } });

        await expect(callerSessionMarks(context)).resolves.toStrictEqual({ draft: "extension" });
        await expect(callerSessionNotOwn(context)).resolves.toBe(true);
    });

    it("marks an admin's steer impersonated and a confirmed own one with nothing", async () => {
        await expect(callerSessionMarks(contextWith({ identity: { sessionId: "s1" }, impersonatedBy: "admin", session: liveSession }))).resolves.toStrictEqual({
            impersonated: true,
        });
        await expect(callerSessionMarks(contextWith({ identity: { sessionId: "s1" }, session: liveSession }))).resolves.toStrictEqual({});
    });

    it.each([
        ["an admin acting as the owner", { identity: { sessionId: "s1" }, impersonatedBy: "admin", session: liveSession }],
        ["a session marked impersonated", { identity: { sessionId: "s1" }, session: { ...liveSession, impersonatedBy: "admin" } }],
        ["a session row that is gone (an ended impersonation)", { identity: { sessionId: "s1" }, session: null }],
        ["another user's session", { identity: { sessionId: "s1" }, session: { ...liveSession, userId: "user-other" } }],
        ["an expired session", { identity: { sessionId: "s1" }, session: { ...liveSession, expiresAt: NOW } }],
        ["no sign-in at all", { identity: { userId: OWNER }, session: liveSession }],
    ])("marks %s", async (_name, options) => {
        await expect(callerSessionNotOwn(contextWith(options))).resolves.toBe(true);
    });

    it("marks an answer whose session read fails", async () => {
        const failing = async (): Promise<SessionRow> => {
            throw new Error("down");
        };

        await expect(callerSessionNotOwn(contextWith({ identity: { sessionId: "s1" }, read: failing }))).resolves.toBe(true);
    });
});
