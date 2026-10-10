/**
 * The push procedures over `@lunora/notify`'s in-memory store. Not the
 * harness's `notify` option: `lunora/notify.ts` builds a fresh memory store per
 * ctx off D1, so subscriptions would not outlive one call. Each handler runs on
 * a harness ctx with one shared `createNotify` facade spliced in instead.
 */
import { createNotify, defineNotify, memorySubscriptionStore } from "@lunora/notify";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getPushSubscriptionStatus, MAX_PUSH_SUBSCRIPTIONS_PER_USER, subscribePush, unsubscribePush } from "./push";

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const USER = "user-a";
const OTHER = "user-b";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const KEYS = { auth: "auth", p256dh: "key" };

let harness: ReturnType<typeof lunoraTest>;
let push: ReturnType<typeof createNotify>["push"];

type Handler<R> = { handler: (ctx: object, args: Record<string, unknown>) => Promise<R> };

const call = async <R>(procedure: unknown, userId: string, args: Record<string, unknown>): Promise<R> =>
    await harness.run(async (ctx: object) => await (procedure as Handler<R>).handler({ ...ctx, auth: { userId }, push }, args));

const statusOf = async (userId: string, endpoint: string): Promise<boolean> => {
    const { subscribed } = await call<{ subscribed: boolean }>(getPushSubscriptionStatus, userId, { endpoint });

    return subscribed;
};

beforeEach(() => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
    harness = lunoraTest(schema as never);
    ({ push } = createNotify(
        defineNotify({ store: () => memorySubscriptionStore(), webPush: { vapidPrivateKey: "x", vapidPublicKey: "y", vapidSubject: "mailto:a@b.c" } }),
        {},
        { silent: true },
    ));
});

afterEach(() => {
    harness.close();
    vi.unstubAllEnvs();
});

describe("push subscriptions", () => {
    it("reads on only for the account holding this browser's subscription", async () => {
        await call(subscribePush, USER, { endpoint: ENDPOINT, keys: KEYS });

        expect(await statusOf(USER, ENDPOINT)).toBe(true);
        expect(await statusOf(USER, "https://fcm.googleapis.com/fcm/send/other")).toBe(false);
        expect(await statusOf(OTHER, ENDPOINT)).toBe(false);
    });

    it("reports an endpoint another account still holds as taken, and leaves it theirs", async () => {
        await call(subscribePush, USER, { endpoint: ENDPOINT, keys: KEYS });

        expect(await call(subscribePush, OTHER, { endpoint: ENDPOINT, keys: KEYS })).toStrictEqual({ taken: true });
        await call(unsubscribePush, OTHER, { endpoint: ENDPOINT });
        expect(await statusOf(USER, ENDPOINT)).toBe(true);
    });

    it("frees the endpoint on unsubscribe, and drops the replaced one after a key rotation", async () => {
        await call(subscribePush, USER, { endpoint: ENDPOINT, keys: KEYS });
        await call(subscribePush, USER, { endpoint: `${ENDPOINT}-new`, keys: KEYS, replacedEndpoint: ENDPOINT });

        expect(await statusOf(USER, ENDPOINT)).toBe(false);

        await call(unsubscribePush, USER, { endpoint: `${ENDPOINT}-new` });

        expect(await call(subscribePush, OTHER, { endpoint: `${ENDPOINT}-new`, keys: KEYS })).toStrictEqual({ taken: false });
    });

    it(`keeps at most ${String(MAX_PUSH_SUBSCRIPTIONS_PER_USER)} browsers, dropping the one not seen for longest`, async () => {
        vi.useFakeTimers();

        // Seeded straight into the store: the procedure's rate limit allows fewer calls than the cap.
        for (let index = 0; index < MAX_PUSH_SUBSCRIPTIONS_PER_USER; index += 1) {
            vi.setSystemTime(1000 + index);
            await push.register({ subscription: { endpoint: `${ENDPOINT}-${String(index)}`, keys: KEYS }, userId: USER });
        }

        vi.setSystemTime(2000);
        await call(subscribePush, USER, { endpoint: ENDPOINT, keys: KEYS });
        vi.useRealTimers();

        const devices = await push.list({ userId: USER });

        expect(devices).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
        expect(devices.map((device) => device.endpoint)).not.toContain(`${ENDPOINT}-0`);
        expect(devices.map((device) => device.endpoint)).toContain(ENDPOINT);
    });
});
