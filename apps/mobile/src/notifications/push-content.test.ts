import { describe, expect, it, vi } from "vitest";

import type { StoredGrant } from "../auth/grant";
import { channelName } from "./push-channel";
import type { PushText } from "./push-content";
import { fetchPushContent, NOT_THIS_ACCOUNT, pushPlaceholder, showDataOnlyPush, WITHHELD } from "./push-content";

const LUNORA = "https://api.test";
const TOKEN_URL = `${LUNORA}/extension/auth/token`;
const CONTENT_URL = `${LUNORA}/notifications/push-content`;

/** The signed-in grant for `userId`: the one the task reads and mints a token from. */
const grantOf = (userId: string): StoredGrant => {
    return { token: "session", user: { email: "a@b.c", id: userId, image: null, name: "A" } };
};

/**
 * The token route mints a JWT; the content route answers `answer`. Any other URL fails the request, so a wrong path
 * shows up as a missing text rather than passing.
 */
const backend = (answer: { body?: unknown; status?: number }) => vi.fn(async (url: string) => {
    if (url === TOKEN_URL) {
        return Response.json({ token: "jwt" });
    }

    if (url === CONTENT_URL) {
        return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
    }

    throw new Error(`unexpected request to ${url}`);
});

const fetchWith = (answer: { body?: unknown; status?: number }, grant: StoredGrant = grantOf("u1")) => fetchPushContent({ fetch: backend(answer) as never, grant, lunoraUrl: LUNORA, notificationId: "n1" });

describe("fetchPushContent", () => {
    it("returns the text the server gives for a chat the account can read", async () => {
        expect(await fetchWith({ body: { body: "Release run", title: "A tool call needs your approval" } })).toStrictEqual({
            body: "Release run",
            title: "A tool call needs your approval",
        });
    });

    it("asks the content route with the minted token and the notification's id", async () => {
        const fetch = backend({ body: { body: "x", title: "y" } });

        await fetchPushContent({ fetch: fetch as never, grant: grantOf("u1"), lunoraUrl: LUNORA, notificationId: "n1" });

        expect(fetch).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ body: JSON.stringify({ token: "session" }) }));
        expect(fetch).toHaveBeenCalledWith(
            CONTENT_URL,
            expect.objectContaining({
                body: JSON.stringify({ notificationId: "n1" }),
                headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
                method: "POST",
            }),
        );
    });

    it("reports a notification that is not the signed-in account's", async () => {
        expect(await fetchWith({ status: 404 })).toBe(NOT_THIS_ACCOUNT);
    });

    it("reports a chat the server withholds as withheld, not as a failure", async () => {
        expect(await fetchWith({ body: { generic: true } })).toBe(WITHHELD);
    });

    it("leaves the placeholder on a failure on our side", async () => {
        expect(await fetchWith({ status: 503 })).toBeUndefined();
    });

    it("answers nothing when the session is refused, and asks for no text", async () => {
        const fetch = vi.fn(async () => new Response(null, { status: 401 }));

        expect(await fetchPushContent({ fetch: fetch as never, grant: grantOf("u1"), lunoraUrl: LUNORA, notificationId: "n1" })).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

const PUSH = { notificationId: "n1", threadId: "t1" };

/**
 * The steps' session reads, in order: the account that fetched, the check before the post, the check after it. An entry of
 * `undefined` is a phone signed out at that read.
 */
const runTask = async (
    fetched: PushText | typeof NOT_THIS_ACCOUNT | typeof WITHHELD | undefined,
    sessions: (string | undefined)[] = ["u1", "u1", "u1"],
    payload: unknown = PUSH,
) => {
    const reads = [...sessions];
    const fetchContent = vi.fn(async () => fetched);
    const show = vi.fn(async () => undefined);
    const retract = vi.fn(async () => undefined);
    const result = await showDataOnlyPush(payload, {
        fetchContent,
        locale: "de-DE",
        retract,
        session: async () => {
            const userId = reads.shift();

            return userId === undefined ? undefined : grantOf(userId);
        },
        show,
    });

    return { fetchContent, result, retract, show };
};

describe("showDataOnlyPush", () => {
    it("shows the fetched text, with its chat", async () => {
        const { result, retract, show } = await runTask({ body: "Release run", title: "Approval" });

        expect(result).toBe(true);
        expect(show).toHaveBeenCalledWith({ body: "Release run", title: "Approval" }, { notificationId: "n1", threadId: "t1" });
        expect(retract).not.toHaveBeenCalled();
    });

    it("fetches with the grant it read first, not one read later", async () => {
        const { fetchContent } = await runTask(undefined, ["u1", "u2", "u2"]);

        expect(fetchContent).toHaveBeenCalledWith(grantOf("u1"), "n1");
    });

    it("shows the placeholder, with its chat, when the text cannot be had", async () => {
        const { show } = await runTask(undefined);

        expect(show).toHaveBeenCalledWith(pushPlaceholder("de-DE"), { notificationId: "n1", threadId: "t1" });
    });

    it("shows the placeholder without its chat when the server withholds the text", async () => {
        const { show } = await runTask(WITHHELD);

        expect(show).toHaveBeenCalledWith(pushPlaceholder("de-DE"), { notificationId: "n1" });
    });

    it("drops the thread when the account changed while the text was on its way", async () => {
        const { show } = await runTask(undefined, ["u1", "u2"]);

        expect(show).toHaveBeenCalledWith(pushPlaceholder("de-DE"), { notificationId: "n1" });
    });

    it("shows nothing for another account's notification", async () => {
        const { result, show } = await runTask(NOT_THIS_ACCOUNT);

        expect(result).toBe(false);
        expect(show).not.toHaveBeenCalled();
    });

    it("shows nothing when no one is signed in", async () => {
        const { result, show } = await runTask({ body: "x", title: "y" }, [undefined]);

        expect(result).toBe(false);
        expect(show).not.toHaveBeenCalled();
    });

    it("takes the text back when a sign-out lands before the alert is posted", async () => {
        const { retract, show } = await runTask({ body: "Release run", title: "Approval" }, ["u1", "u1", undefined]);

        expect(show).toHaveBeenCalledTimes(1);
        expect(retract).toHaveBeenCalledWith({ notificationId: "n1", threadId: "t1" });
    });

    it("takes a placeholder back when the account changed after it was posted", async () => {
        const { retract, show } = await runTask(undefined, ["u1", "u1", "u2"]);

        expect(show).toHaveBeenCalledWith(pushPlaceholder("de-DE"), { notificationId: "n1", threadId: "t1" });
        expect(retract).toHaveBeenCalledWith({ notificationId: "n1", threadId: "t1" });
    });

    it("posts the alert even when the channel set-up fails", async () => {
        const show = vi.fn(async () => undefined);
        const result = await showDataOnlyPush(PUSH, {
            fetchContent: vi.fn(async () => { return { body: "Release run", title: "Approval" }; }),
            locale: "de-DE",
            prepare: () => Promise.reject(new Error("no channel")),
            session: async () => grantOf("u1"),
            show,
        });

        expect(result).toBe(true);
        expect(show).toHaveBeenCalledWith({ body: "Release run", title: "Approval" }, PUSH);
    });

    it("lets an error while posting reach the caller, which answers it", async () => {
        await expect(
            showDataOnlyPush(PUSH, {
                fetchContent: vi.fn(async () => undefined),
                locale: "de-DE",
                session: async () => grantOf("u1"),
                show: () => Promise.reject(new Error("no alerts")),
            }),
        ).rejects.toThrow("no alerts");
    });

    it("leaves a notification-style push to the system, even in the foreground where the task also runs", async () => {
        // The envelope expo-notifications hands the task for a push that carries its own alert (an approval, or any
        // push sent before this build registered), with the ids under `data`.
        const fetchContent = vi.fn(() => Promise.resolve({ body: "x", title: "y" }));
        const payload = { data: { approvalId: "a1", notificationId: "n1" }, notification: { body: "Mira", title: "shell" } };
        const result = await showDataOnlyPush(payload, {
            fetchContent,
            locale: "de-DE",
            session: async () => grantOf("u1"),
            show: vi.fn(async () => undefined),
        });

        expect(result).toBe(false);
        expect(fetchContent).not.toHaveBeenCalled();
    });

    it("builds the alert for a data-only push, whose envelope has no notification", async () => {
        const { result, show } = await runTask({ body: "Release run", title: "Approval" }, undefined, {
            data: PUSH,
            notification: null,
        });

        expect(result).toBe(true);
        expect(show).toHaveBeenCalledWith({ body: "Release run", title: "Approval" }, PUSH);
    });
});

describe("pushPlaceholder and channelName", () => {
    it("falls back to English for a language without a placeholder", () => {
        expect(pushPlaceholder("sv")).toStrictEqual({ body: "You have a new notification", title: "Neore" });
    });

    it("names the channel in the phone's language, in English without one", () => {
        expect(channelName("de-AT")).toBe("Benachrichtigungen");
        expect(channelName("sv")).toBe("Notifications");
        expect(channelName(undefined)).toBe("Notifications");
    });
});
