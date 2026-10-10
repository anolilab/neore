import { describe, expect, it } from "vitest";

import { hasThreadReadAccess, redactThreadForPublicViewer } from "./thread-read-access";

const NOW = 1_700_000_000_000;

describe("hasThreadReadAccess", () => {
    it("lets the owner read", () => {
        expect(hasThreadReadAccess({ access: null, now: NOW, thread: { userId: "owner" }, userId: "owner" })).toBe(true);
    });

    it("denies a stranger, even on a thread without an owner", () => {
        expect(hasThreadReadAccess({ access: null, now: NOW, thread: { userId: "owner" }, userId: "stranger" })).toBe(false);
        expect(hasThreadReadAccess({ access: undefined, now: NOW, thread: {}, userId: "stranger" })).toBe(false);
    });

    it("lets an invitee read until the grant expires", () => {
        const thread = { userId: "owner" };

        expect(hasThreadReadAccess({ access: {}, now: NOW, thread, userId: "invitee" })).toBe(true);
        expect(hasThreadReadAccess({ access: { expiresAt: NOW + 1 }, now: NOW, thread, userId: "invitee" })).toBe(true);
        expect(hasThreadReadAccess({ access: { expiresAt: NOW - 1 }, now: NOW, thread, userId: "invitee" })).toBe(false);
    });
});

describe("redactThreadForPublicViewer", () => {
    it("keeps only the allow-listed fields", () => {
        expect(
            redactThreadForPublicViewer({
                _creationTime: 1,
                _id: "t1",
                customSystemPrompt: "secret",
                mode: "text",
                organizationId: "org",
                publicAccessToken: "tok",
                status: "active",
                summary: "private summary",
                teamId: "team",
                title: "Shared",
                userId: "owner",
            }),
        ).toEqual({ _creationTime: 1, _id: "t1", isPublic: true, mode: "text", publicAccessToken: "tok", status: "active", title: "Shared" });
    });
});
