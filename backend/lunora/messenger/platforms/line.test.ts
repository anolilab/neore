import { describe, expect, it } from "vitest";

import { bytesToBase64, hmacSha256 } from "../../lib/crypto";
import { isFreshInbound } from "../lib/types";
import { LINE_EVENT_MAX_AGE_MS, parseLineWebhook, validateLineSignature } from "./line";

const SECRET = "line-channel-secret";
const NOW = 1_800_000_000_000;

const sign = async (body: string, secret = SECRET): Promise<string> => bytesToBase64(await hmacSha256(secret, body));

const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        deliveryContext: { isRedelivery: false },
        message: { id: "468789577898262530", quoteToken: "q", text: "Hello", type: "text" },
        mode: "active",
        replyToken: "38ef843bde154d9b91c21320ffd17a0f",
        source: { type: "user", userId: "U4af4980629" },
        timestamp: NOW,
        type: "message",
        webhookEventId: "01FZ74A0TDDPYRVKNK77XKC3ZR",
        ...overrides,
    };
};

describe("validateLineSignature", () => {
    const body = JSON.stringify({ destination: "Uxxx", events: [event()] });

    it("accepts the base64 HMAC-SHA256 of the raw body", async () => {
        await expect(validateLineSignature(await sign(body), body, SECRET)).resolves.toBe(true);
    });

    it("accepts the console's empty verification batch", async () => {
        const verify = JSON.stringify({ destination: "Uxxx", events: [] });

        await expect(validateLineSignature(await sign(verify), verify, SECRET)).resolves.toBe(true);
        expect(parseLineWebhook(JSON.parse(verify))).toEqual([]);
    });

    it("rejects a tampered body, another secret or no header", async () => {
        await expect(validateLineSignature(await sign(body), `${body} `, SECRET)).resolves.toBe(false);
        await expect(validateLineSignature(await sign(body, "other"), body, SECRET)).resolves.toBe(false);
        await expect(validateLineSignature(null, body, SECRET)).resolves.toBe(false);
    });

    it("a replayed event past the redelivery window is not fresh", () => {
        const [message] = parseLineWebhook({ events: [event()] });

        expect(isFreshInbound(message!, LINE_EVENT_MAX_AGE_MS, NOW + 1000)).toBe(true);
        expect(isFreshInbound(message!, LINE_EVENT_MAX_AGE_MS, NOW + LINE_EVENT_MAX_AGE_MS + 1)).toBe(false);
    });
});

describe("parseLineWebhook", () => {
    it("parses a text message event with its reply token and dedupe id", () => {
        expect(parseLineWebhook({ events: [event()] })).toEqual([
            {
                chatId: "U4af4980629",
                eventId: "01FZ74A0TDDPYRVKNK77XKC3ZR",
                kind: "text",
                replyToken: "38ef843bde154d9b91c21320ffd17a0f",
                senderId: "U4af4980629",
                text: "Hello",
                timestampMs: NOW,
            },
        ]);
    });

    it("replies into the group, not the sender, for group messages", () => {
        const [message] = parseLineWebhook({ events: [event({ source: { groupId: "Cgroup", type: "group", userId: "U1" } })] });

        expect(message?.chatId).toBe("Cgroup");
        expect(message?.senderId).toBe("U1");
    });

    it("reads audio as a voice note, marks video unsupported, and skips non-message and standby events", () => {
        const events = [
            event({ message: { contentProvider: { type: "line" }, id: "1", type: "audio" }, webhookEventId: "a" }),
            event({ type: "follow", webhookEventId: "b" }),
            event({ mode: "standby", webhookEventId: "c" }),
            event({ source: { type: "user" }, webhookEventId: "d" }),
            event({ message: { contentProvider: { type: "line" }, id: "2", type: "video" }, webhookEventId: "e" }),
        ];
        const parsed = parseLineWebhook({ events });

        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ attachments: [{ kind: "voice", ref: "1" }], kind: "media" });
        expect(parsed[1]?.kind).toBe("unsupported");
    });
});
