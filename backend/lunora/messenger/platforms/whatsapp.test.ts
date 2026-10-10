import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256 } from "../../lib/crypto";
import { isFreshInbound } from "../lib/types";
import { isWhatsAppWindowOpen, parseWhatsAppWebhook, validateWhatsAppSignature, verifyWhatsAppSubscription, WHATSAPP_SERVICE_WINDOW_MS } from "./whatsapp";

const APP_SECRET = "whatsapp-app-secret";
const PHONE_ID = "106540352242922";
const NOW = 1_800_000_000_000;

const sign = async (body: string, secret = APP_SECRET): Promise<string> => `sha256=${bytesToHex(await hmacSha256(secret, body))}`;

const webhook = (message: Record<string, unknown>, phoneNumberId = PHONE_ID): Record<string, unknown> => {
    return {
        entry: [
            {
                changes: [
                    {
                        field: "messages",
                        value: {
                            contacts: [{ profile: { name: "Ada" }, wa_id: "4915112345678" }],
                            messages: [{ from: "4915112345678", id: "wamid.ABC", timestamp: String(NOW / 1000), ...message }],
                            metadata: { phone_number_id: phoneNumberId },
                        },
                    },
                ],
                id: "WABA",
            },
        ],
        object: "whatsapp_business_account",
    };
};

describe("verifyWhatsAppSubscription", () => {
    const url = (token: string, mode = "subscribe"): URL =>
        new URL(`https://api.example.com/messenger/whatsapp/c1?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=1158201444`);

    it("echoes the challenge for the configured token", () => {
        expect(verifyWhatsAppSubscription(url("my-token"), "my-token")).toBe("1158201444");
    });

    it("refuses a wrong token or mode", () => {
        expect(verifyWhatsAppSubscription(url("other"), "my-token")).toBeNull();
        expect(verifyWhatsAppSubscription(url("my-token", "unsubscribe"), "my-token")).toBeNull();
    });
});

describe("validateWhatsAppSignature", () => {
    const body = JSON.stringify(webhook({ text: { body: "hi" }, type: "text" }));

    it("accepts the App Secret HMAC of the raw body", async () => {
        await expect(validateWhatsAppSignature(await sign(body), body, APP_SECRET)).resolves.toBe(true);
    });

    it("rejects a tampered body, another secret, a missing prefix or header", async () => {
        const signature = await sign(body);

        await expect(validateWhatsAppSignature(signature, body.replace("hi", "ho"), APP_SECRET)).resolves.toBe(false);
        await expect(validateWhatsAppSignature(await sign(body, "other"), body, APP_SECRET)).resolves.toBe(false);
        await expect(validateWhatsAppSignature(signature.slice("sha256=".length), body, APP_SECRET)).resolves.toBe(false);
        await expect(validateWhatsAppSignature(null, body, APP_SECRET)).resolves.toBe(false);
    });

    it("a replayed request still verifies — replay protection is the timestamp window and the id dedupe", async () => {
        await expect(validateWhatsAppSignature(await sign(body), body, APP_SECRET)).resolves.toBe(true);

        const [message] = parseWhatsAppWebhook(JSON.parse(body), PHONE_ID);

        expect(isFreshInbound(message!, WHATSAPP_SERVICE_WINDOW_MS, NOW + 60_000)).toBe(true);
        expect(isFreshInbound(message!, WHATSAPP_SERVICE_WINDOW_MS, NOW + WHATSAPP_SERVICE_WINDOW_MS + 1)).toBe(false);
    });
});

describe("parseWhatsAppWebhook", () => {
    it("parses a text message with the sender's profile name", () => {
        expect(parseWhatsAppWebhook(webhook({ text: { body: "Hello" }, type: "text" }), PHONE_ID)).toEqual([
            {
                chatId: "4915112345678",
                eventId: "wamid.ABC",
                kind: "text",
                senderId: "4915112345678",
                senderName: "Ada",
                text: "Hello",
                timestampMs: NOW,
            },
        ]);
    });

    it("reads audio as media and marks stickers unsupported", () => {
        const [audio] = parseWhatsAppWebhook(webhook({ audio: { id: "media" }, type: "audio" }), PHONE_ID);
        const [sticker] = parseWhatsAppWebhook(webhook({ sticker: { id: "stk" }, type: "sticker" }), PHONE_ID);

        expect(audio).toMatchObject({ attachments: [{ kind: "audio", ref: "media" }], kind: "media" });
        expect(audio?.text).toBeUndefined();
        expect(sticker?.kind).toBe("unsupported");
    });

    it("ignores status updates, other phone numbers and other objects", () => {
        const statuses = {
            entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: "x" }] } }] }],
            object: "whatsapp_business_account",
        };

        expect(parseWhatsAppWebhook(statuses, PHONE_ID)).toEqual([]);
        expect(parseWhatsAppWebhook(webhook({ text: { body: "x" }, type: "text" }, "999"), PHONE_ID)).toEqual([]);
        expect(parseWhatsAppWebhook({ object: "page" }, PHONE_ID)).toEqual([]);
        expect(parseWhatsAppWebhook(null, PHONE_ID)).toEqual([]);
    });
});

describe("isWhatsAppWindowOpen", () => {
    it("is open for 24 hours after the customer's message", () => {
        expect(isWhatsAppWindowOpen(NOW, NOW + WHATSAPP_SERVICE_WINDOW_MS - 1)).toBe(true);
        expect(isWhatsAppWindowOpen(NOW, NOW + WHATSAPP_SERVICE_WINDOW_MS)).toBe(false);
        expect(isWhatsAppWindowOpen(NaN, NOW)).toBe(false);
    });
});
