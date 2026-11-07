import { describe, expect, it, vi } from "vitest";

import type { GrantStore } from "../auth/grant";
import { channelName, fetchPushContent, NOT_THIS_ACCOUNT, pushPlaceholder, showDataOnlyPush } from "./push-content";

const LUNORA = "https://api.test";

const store = (token: string | null): GrantStore => {
    return {
        clear: vi.fn(async () => undefined),
        get: vi.fn(async () => {
            if (token === null) {
                return null;
            }

            return { token, user: { email: "a@b.c", id: "u1", image: null, name: "A" } };
        }),
        set: vi.fn(async () => undefined),
    };
};

/** The token route mints a JWT; the content route answers `content`. */
const backend = (content: { body?: unknown; status?: number }) =>
    vi.fn(async (url: string) => {
        if (url.endsWith("/extension/auth/token")) {
            return Response.json({ token: "jwt" });
        }

        return Response.json(content.body ?? {}, { status: content.status ?? 200 });
    });

describe("fetchPushContent", () => {
    it("signs in with the session and asks for the notification's text", async () => {
        const fetch = backend({ body: { body: "Release run", title: "A tool call needs your approval" } });

        expect(await fetchPushContent({ fetch: fetch as never, lunoraUrl: LUNORA, notificationId: "n1", store: store("session") })).toStrictEqual({
            body: "Release run",
            title: "A tool call needs your approval",
        });

        const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];

        expect(url).toBe(`${LUNORA}/notifications/push-content`);
        expect(init.headers).toMatchObject({ Authorization: "Bearer jwt" });
        expect(JSON.parse(init.body as string)).toStrictEqual({ notificationId: "n1" });
    });

    it.each([
        ["a locked chat", { body: { generic: true } }],
        ["a failure on our side", { body: { error: "UNAVAILABLE" }, status: 503 }],
    ])("keeps the placeholder for %s", async (_label, content) => {
        expect(await fetchPushContent({ fetch: backend(content) as never, lunoraUrl: LUNORA, notificationId: "n1", store: store("session") })).toBeUndefined();
    });

    it("tells another account's notification apart, so nothing of it shows", async () => {
        const fetched = await fetchPushContent({ fetch: backend({ body: { error: "NOT_FOUND" }, status: 404 }) as never, lunoraUrl: LUNORA, notificationId: "n1", store: store("session") });

        expect(fetched).toBe(NOT_THIS_ACCOUNT);
    });

    it("keeps the placeholder when signed out or offline, and never throws", async () => {
        const offline = vi.fn(async () => {
            throw new TypeError("Network request failed");
        });

        expect(await fetchPushContent({ fetch: backend({}) as never, lunoraUrl: LUNORA, notificationId: "n1", store: store(null) })).toBeUndefined();
        expect(await fetchPushContent({ fetch: offline as never, lunoraUrl: LUNORA, notificationId: "n1", store: store("session") })).toBeUndefined();
    });
});

describe("pushPlaceholder", () => {
    it("words the placeholder in the phone's language, English otherwise", () => {
        expect(pushPlaceholder("de-AT")).toStrictEqual({ body: "Du hast eine neue Benachrichtigung", title: "Neore" });
        expect(pushPlaceholder("sv-SE").body).toBe("You have a new notification");
        expect(pushPlaceholder(undefined).body).toBe("You have a new notification");
    });
});

describe("channelName", () => {
    it("names the Android channel in the phone's language, English otherwise", () => {
        expect(channelName("de-DE")).toBe("Benachrichtigungen");
        expect(channelName("ja-JP")).toBe("通知");
        expect(channelName("sv-SE")).toBe("Notifications");
        expect(channelName(undefined)).toBe("Notifications");
    });
});

describe("showDataOnlyPush", () => {
    const steps = (overrides: Partial<Parameters<typeof showDataOnlyPush>[1]> = {}) => {
        return {
            fetchContent: vi.fn(async () => {
                return { body: "Release run", title: "A tool call needs your approval" };
            }),
            locale: "en-US",
            sessionUserId: vi.fn(async () => "u1"),
            show: vi.fn(async () => undefined),
            ...overrides,
        };
    };

    it("shows the fetched text, carrying the ids so a tap opens the chat", async () => {
        const task = steps();

        expect(await showDataOnlyPush({ data: { dataString: JSON.stringify({ notificationId: "n1", threadId: "t1" }) } }, task)).toBe(true);
        expect(task.fetchContent).toHaveBeenCalledWith("n1");
        expect(task.show).toHaveBeenCalledWith({ body: "Release run", title: "A tool call needs your approval" }, { notificationId: "n1", threadId: "t1" });
    });

    it("shows the placeholder in the phone's language when the text cannot be had", async () => {
        const task = steps({ fetchContent: vi.fn(async () => undefined), locale: "fr-FR" });

        await showDataOnlyPush({ notificationId: "n1" }, task);

        expect(task.show).toHaveBeenCalledWith({ body: "Vous avez une nouvelle notification", title: "Neore" }, { notificationId: "n1" });
    });

    it.each([
        ["signed out", undefined],
        ["switched to another account", "u2"],
    ])("shows the placeholder, never the former account's text, when the phone %s while the text was on its way", async (_label, after) => {
        const task = steps({ sessionUserId: vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce("u1").mockResolvedValueOnce(after) });

        await showDataOnlyPush({ notificationId: "n1" }, task);

        expect(task.show).toHaveBeenCalledWith({ body: "You have a new notification", title: "Neore" }, { notificationId: "n1" });
    });

    it("posts nothing, and keeps no ids, for a notification the server says is not the signed-in account's", async () => {
        const task = steps({ fetchContent: vi.fn(async () => NOT_THIS_ACCOUNT as typeof NOT_THIS_ACCOUNT) });

        expect(await showDataOnlyPush({ notificationId: "n1", threadId: "old-chat" }, task)).toBe(false);
        expect(task.show).not.toHaveBeenCalled();
    });

    it("shows nothing for a push without ids, or when nobody is signed in on the phone", async () => {
        const task = steps({ sessionUserId: vi.fn(async () => undefined) });

        expect(await showDataOnlyPush({ unrelated: true }, steps())).toBe(false);
        expect(await showDataOnlyPush({ notificationId: "n1" }, task)).toBe(false);
        expect(task.show).not.toHaveBeenCalled();
    });
});
