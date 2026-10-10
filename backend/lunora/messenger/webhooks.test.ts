/**
 * Telegram, Slack and Discord go through the same pipeline as every other
 * platform (`acceptInbound`): freshness → claim-once dedupe → pairing → rate
 * limits → persist and schedule the reply. Each test drives the real handler
 * with a correctly signed request; only the rate limiter and the key lookup
 * are stubbed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { claimKey } from "../lib/claim-once";
import { bytesToHex, hmacSha256Hex } from "../lib/crypto";
import { findOrCreateMessengerThread, getConnectionById, pairConnection, saveMessengerMessage, touchConnection } from "./functions";
import { handleDiscordWebhook, handleSlackWebhook, handleTelegramWebhook } from "./webhooks";

const rateLimit = vi.hoisted(() => {
    return { ok: true, operations: [] as string[] };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        checkRateLimit: async (_context: unknown, operation: string) => {
            rateLimit.operations.push(operation);

            return { ok: rateLimit.ok || !operation.startsWith("messenger/connection") };
        },
    };
});

const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const OWNER = "user-owner";
const SENDER = "4242";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const MUTATIONS: Record<string, unknown> = {
    "lib_claim_once:claimKey": claimKey,
    "messenger_functions:findOrCreateMessengerThread": findOrCreateMessengerThread,
    "messenger_functions:pairConnection": pairConnection,
    "messenger_functions:saveMessengerMessage": saveMessengerMessage,
    "messenger_functions:touchConnection": touchConnection,
};

const pathOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

/** An `HttpActionCtx` stand-in running the real internal functions against the harness. */
const httpContext = (keys: Record<string, string>) => {
    const scheduled: { args: Record<string, unknown>; path: string }[] = [];
    const context = {
        runMutation: async (reference: unknown, args: unknown) => {
            const registered = MUTATIONS[pathOf(reference)];

            if (!registered) {
                throw new Error(`unexpected mutation ${pathOf(reference)}`);
            }

            return await harness.run(async (ctx: any) => await ctx.runMutation(registered, args));
        },
        runQuery: async (reference: unknown, args: unknown) => {
            switch (pathOf(reference)) {
                case "auth_functions:getDecryptedMessengerKeysQuery": {
                    return keys;
                }
                case "messenger_functions:getConnectionById": {
                    return await harness.run(async (ctx: any) => await ctx.runQuery(getConnectionById, args));
                }
                case "messenger_functions:getOwnerRateLimitTier": {
                    return "free";
                }
                default: {
                    throw new Error(`unexpected query ${pathOf(reference)}`);
                }
            }
        },
        scheduler: {
            runAfter: async (_delay: number, reference: unknown, args: Record<string, unknown>) => {
                scheduled.push({ args, path: pathOf(reference) });
            },
        },
    };

    return {
        context: context as never,
        /** Model replies scheduled — notices (pairing, private bot) are excluded. */
        replies: () => scheduled.filter((entry) => entry.path === "messenger_respond:generateAndSendResponse").map((entry) => entry.args),
    };
};

/** A connection, paired to `SENDER` unless `fields` says otherwise. */
const connection = async (platform: string, fields?: Record<string, unknown>): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messengerConnections", {
                connectedAt: NOW,
                platform,
                status: "active",
                userId: OWNER,
                ...(fields ?? { platformUserId: SENDER }),
            }),
    );

const statusOf = async (pending: Promise<Response>): Promise<number> => {
    const response = await pending;

    return response.status;
};

const jsonOf = async (pending: Promise<Response>): Promise<unknown> => {
    const response = await pending;

    return await response.json();
};

const savedTexts = async (): Promise<string[]> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("messages").collect();

        return rows.map((row: { text: string }) => row.text);
    });

const post = (body: string, headers: Record<string, string>): Request => new Request("https://x/messenger/hook", { body, headers, method: "POST" });

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    rateLimit.ok = true;
    rateLimit.operations = [];
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("Telegram through acceptInbound", () => {
    const KEYS = { telegram_bot_token: "bot", telegram_webhook_secret: "tg-secret" };
    const update = (messageId: number, date = NOW_SECONDS, text = "hello") =>
        JSON.stringify({
            message: { chat: { id: 77, type: "private" }, date, from: { first_name: "Ada", id: Number(SENDER), is_bot: false }, message_id: messageId, text },
            update_id: messageId,
        });
    const send = async (context: never, connectionId: string, body: string, secret = KEYS.telegram_webhook_secret) =>
        await handleTelegramWebhook(context, post(body, { "x-telegram-bot-api-secret-token": secret }), connectionId);

    it("answers a paired sender once, however often the update is redelivered", async () => {
        const connectionId = await connection("telegram");
        const { context, replies } = httpContext(KEYS);

        expect(await statusOf(send(context, connectionId, update(1)))).toBe(200);
        expect(await statusOf(send(context, connectionId, update(1)))).toBe(200);

        expect(replies()).toStrictEqual([
            expect.objectContaining({ inboundAt: NOW_SECONDS * 1000, platform: "telegram", platformChatId: "77", userId: OWNER }),
        ]);
        expect(await savedTexts()).toStrictEqual(["hello"]);
    });

    it("saves a photo pending in arrival order, hands it to the reply action, and answers a sticker with the notice", async () => {
        const connectionId = await connection("telegram");
        const { context, replies } = httpContext(KEYS);
        const photo = JSON.stringify({
            message: {
                caption: "what is this?",
                chat: { id: 77, type: "private" },
                date: NOW_SECONDS,
                from: { first_name: "Ada", id: Number(SENDER), is_bot: false },
                message_id: 5,
                photo: [{ file_id: "AgAC-large", file_size: 90_000, file_unique_id: "u", height: 1280, width: 1280 }],
            },
            update_id: 5,
        });
        const sticker = JSON.stringify({
            message: {
                chat: { id: 77, type: "private" },
                date: NOW_SECONDS,
                from: { first_name: "Ada", id: Number(SENDER), is_bot: false },
                message_id: 6,
                sticker: { file_id: "s" },
            },
            update_id: 6,
        });

        expect(await statusOf(send(context, connectionId, photo))).toBe(200);
        expect(await statusOf(send(context, connectionId, sticker))).toBe(200);

        expect(replies()).toStrictEqual([
            expect.objectContaining({
                attachments: [{ kind: "image", mimeType: "image/jpeg", ref: "AgAC-large", size: 90_000 }],
                caption: "what is this?",
                notice: undefined,
            }),
            expect.objectContaining({ notice: expect.stringContaining("stickers") }),
        ]);
        expect(replies()[1]).not.toHaveProperty("attachments");
        // Its place in the thread is taken here; the reply action completes the
        // row once the photo is stored. The sticker saves nothing.
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

        expect(rows.map((row: { status: string; text: string }) => [row.text, row.status])).toStrictEqual([["what is this?", "pending"]]);
        expect(replies()[0]).toMatchObject({ messageId: rows[0]._id });
    });

    it("refuses a wrong secret with 401 and drops an update older than Telegram retains", async () => {
        const connectionId = await connection("telegram");
        const { context, replies } = httpContext(KEYS);

        expect(await statusOf(send(context, connectionId, update(1), "wrong"))).toBe(401);
        expect(await statusOf(send(context, connectionId, update(2, NOW_SECONDS - 25 * 60 * 60)))).toBe(200);
        expect(replies()).toHaveLength(0);
    });

    it("does not answer an unpaired stranger", async () => {
        const connectionId = await connection("telegram", {});
        const { context, replies } = httpContext(KEYS);

        expect(await statusOf(send(context, connectionId, update(1)))).toBe(200);
        expect(replies()).toHaveLength(0);
        expect(await savedTexts()).toStrictEqual([]);
    });

    it("applies the per-connection limit, answering 200 so the platform does not retry", async () => {
        const connectionId = await connection("telegram");
        const { context, replies } = httpContext(KEYS);

        rateLimit.ok = false;

        expect(await statusOf(send(context, connectionId, update(1)))).toBe(200);
        expect(replies()).toHaveLength(0);
        expect(rateLimit.operations).toContain("messenger/connection:free");
    });
});

describe("Slack through acceptInbound", () => {
    const KEYS = { slack_bot_token: "xoxb", slack_signing_secret: "slack-secret" };
    const signed = async (body: string, timestamp = NOW_SECONDS) => {
        return {
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": `v0=${await hmacSha256Hex(KEYS.slack_signing_secret, `v0:${String(timestamp)}:${body}`)}`,
        };
    };
    const event = (ts: string, threadTs?: string) =>
        JSON.stringify({ event: { channel: "C1", text: "hi", thread_ts: threadTs, ts, type: "message", user: SENDER }, type: "event_callback" });

    it("replies in the message's thread, once per event", async () => {
        const connectionId = await connection("slack");
        const { context, replies } = httpContext(KEYS);
        const body = event(`${String(NOW_SECONDS)}.000100`, "1799999000.000001");

        expect(await statusOf(handleSlackWebhook(context, post(body, await signed(body)), connectionId))).toBe(200);
        expect(await statusOf(handleSlackWebhook(context, post(body, await signed(body)), connectionId))).toBe(200);

        expect(replies()).toStrictEqual([expect.objectContaining({ platform: "slack", platformChatId: "C1", platformThreadTs: "1799999000.000001" })]);

        const threads = await harness.run(async (ctx: any) => await ctx.db.query("threads").collect());

        expect(threads.map((thread: { externalThreadId: string }) => thread.externalThreadId)).toStrictEqual(["slack:C1:1799999000.000001"]);
    });

    it("answers url_verification only when signed, and refuses a request signed outside the window", async () => {
        const connectionId = await connection("slack");
        const { context } = httpContext(KEYS);
        const challenge = JSON.stringify({ challenge: "abc", type: "url_verification" });

        expect(await jsonOf(handleSlackWebhook(context, post(challenge, await signed(challenge)), connectionId))).toStrictEqual({ challenge: "abc" });
        expect(await statusOf(handleSlackWebhook(context, post(challenge, {}), connectionId))).toBe(401);
        expect(await statusOf(handleSlackWebhook(context, post(challenge, await signed(challenge, NOW_SECONDS - 301)), connectionId))).toBe(401);
    });
});

describe("Discord through acceptInbound", () => {
    const keyPair = async () => (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const signed = async (pair: CryptoKeyPair, body: string, timestamp = NOW_SECONDS) => {
        const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(`${String(timestamp)}${body}`));

        return { "x-signature-ed25519": bytesToHex(new Uint8Array(signature)), "x-signature-timestamp": String(timestamp) };
    };
    const keysFor = async (pair: CryptoKeyPair) => {
        return {
            discord_bot_token: "bot",
            discord_public_key: bytesToHex(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
        };
    };
    const message = JSON.stringify({ d: { author: { id: SENDER, username: "ada" }, channel_id: "D1", content: "yo", id: "m1" }, t: "MESSAGE_CREATE" });

    it("answers a signed PING and a paired message once", async () => {
        const pair = await keyPair();
        const connectionId = await connection("discord");
        const { context, replies } = httpContext(await keysFor(pair));
        const ping = JSON.stringify({ id: "p", token: "t", type: 1 });

        expect(await jsonOf(handleDiscordWebhook(context, post(ping, await signed(pair, ping)), connectionId))).toStrictEqual({ type: 1 });

        await handleDiscordWebhook(context, post(message, await signed(pair, message)), connectionId);
        await handleDiscordWebhook(context, post(message, await signed(pair, message)), connectionId);

        expect(replies()).toStrictEqual([expect.objectContaining({ platform: "discord", platformChatId: "D1" })]);
    });

    it("refuses a correctly signed request replayed outside the window", async () => {
        const pair = await keyPair();
        const connectionId = await connection("discord");
        const { context, replies } = httpContext(await keysFor(pair));

        expect(await statusOf(handleDiscordWebhook(context, post(message, await signed(pair, message, NOW_SECONDS - 301)), connectionId))).toBe(401);
        expect(replies()).toHaveLength(0);
    });
});
