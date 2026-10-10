import { describe, expect, it } from "vitest";

import { bytesToBase64, digestHex, sha256Bytes } from "../../lib/crypto";
import { decryptFeishuPayload, feishuApiBase, parseFeishuEnvelope, validateFeishuSignature } from "./feishu";

const ENCRYPT_KEY = "test key";
const TOKEN = "verification-token";
const NOW = 1_800_000_000_000;

/** What Feishu does: AES-256-CBC, key = SHA-256(encrypt key), random IV prepended, base64. */
const encrypt = async (payload: unknown, encryptKey = ENCRYPT_KEY): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", (await sha256Bytes(encryptKey)) as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ iv, name: "AES-CBC" }, key, new TextEncoder().encode(JSON.stringify(payload))));
    const joined = new Uint8Array(16 + ciphertext.length);

    joined.set(iv);
    joined.set(ciphertext, 16);

    return bytesToBase64(joined);
};

const signedHeaders = async (body: string, timestampSeconds: number, encryptKey = ENCRYPT_KEY): Promise<Headers> => {
    const timestamp = String(timestampSeconds);
    const nonce = "1628432412";

    return new Headers({
        "x-lark-request-nonce": nonce,
        "x-lark-request-timestamp": timestamp,
        "x-lark-signature": await digestHex("SHA-256", timestamp + nonce + encryptKey + body),
    });
};

const messageEvent = (overrides: { content?: string; messageType?: string; senderType?: string; token?: string } = {}): Record<string, unknown> => {
    return {
        event: {
            message: {
                chat_id: "oc_chat",
                chat_type: "p2p",
                content: overrides.content ?? JSON.stringify({ text: "@_user_1 hello there" }),
                create_time: String(NOW),
                message_id: "om_msg",
                message_type: overrides.messageType ?? "text",
            },
            sender: { sender_id: { open_id: "ou_sender" }, sender_type: overrides.senderType ?? "user" },
        },
        header: { app_id: "cli_x", create_time: String(NOW), event_id: "evt_1", event_type: "im.message.receive_v1", token: overrides.token ?? TOKEN },
        schema: "2.0",
    };
};

describe("decryptFeishuPayload", () => {
    it("round-trips Feishu's AES-256-CBC envelope", async () => {
        await expect(decryptFeishuPayload(await encrypt({ hello: "world" }), ENCRYPT_KEY)).resolves.toEqual({ hello: "world" });
    });

    it("fails with the wrong key or a truncated body", async () => {
        const encrypted = await encrypt({ hello: "world" });

        await expect(decryptFeishuPayload(encrypted, "wrong key")).rejects.toThrow();
        await expect(decryptFeishuPayload(encrypted.slice(0, 20), ENCRYPT_KEY)).rejects.toThrow();
    });
});

describe("validateFeishuSignature", () => {
    it("accepts a fresh, correctly signed push", async () => {
        const body = JSON.stringify({ encrypt: await encrypt(messageEvent()) });

        await expect(validateFeishuSignature(await signedHeaders(body, NOW / 1000), body, ENCRYPT_KEY, NOW)).resolves.toBe(true);
    });

    it("rejects a tampered body, another key or missing headers", async () => {
        const body = JSON.stringify({ encrypt: "abc" });
        const headers = await signedHeaders(body, NOW / 1000);

        await expect(validateFeishuSignature(headers, `${body} `, ENCRYPT_KEY, NOW)).resolves.toBe(false);
        await expect(validateFeishuSignature(await signedHeaders(body, NOW / 1000, "other"), body, ENCRYPT_KEY, NOW)).resolves.toBe(false);
        await expect(validateFeishuSignature(new Headers(), body, ENCRYPT_KEY, NOW)).resolves.toBe(false);
    });

    it("rejects a replayed request outside the five-minute window", async () => {
        const body = JSON.stringify({ encrypt: "abc" });

        await expect(validateFeishuSignature(await signedHeaders(body, NOW / 1000 - 301), body, ENCRYPT_KEY, NOW)).resolves.toBe(false);
    });
});

describe("parseFeishuEnvelope", () => {
    it("answers the url_verification challenge only with the right token", () => {
        expect(parseFeishuEnvelope({ challenge: "ajls384kdjx98XX", token: TOKEN, type: "url_verification" }, TOKEN)).toEqual({
            challenge: "ajls384kdjx98XX",
            kind: "challenge",
        });
        expect(parseFeishuEnvelope({ challenge: "x", token: "wrong", type: "url_verification" }, TOKEN)).toBeNull();
    });

    it("parses a text message and strips @-mention placeholders", () => {
        expect(parseFeishuEnvelope(messageEvent(), TOKEN)).toEqual({
            kind: "message",
            message: { chatId: "oc_chat", eventId: "evt_1", kind: "text", senderId: "ou_sender", text: "hello there", timestampMs: NOW },
        });
    });

    it("refuses events carrying the wrong verification token", () => {
        expect(parseFeishuEnvelope(messageEvent({ token: "wrong" }), TOKEN)).toBeNull();
    });

    it("reads an image message as media; marks stickers unsupported; ignores app senders and other events", () => {
        const image = parseFeishuEnvelope(messageEvent({ content: JSON.stringify({ image_key: "img" }), messageType: "image" }), TOKEN);
        const sticker = parseFeishuEnvelope(messageEvent({ content: JSON.stringify({ file_key: "stk" }), messageType: "sticker" }), TOKEN);

        expect(image?.kind === "message" && image.message).toMatchObject({ attachments: [{ kind: "image", ref: "img" }], kind: "media" });
        expect(sticker?.kind === "message" && sticker.message.kind).toBe("unsupported");
        expect(parseFeishuEnvelope(messageEvent({ senderType: "app" }), TOKEN)).toEqual({ kind: "ignored" });
    });
});

describe("feishuApiBase", () => {
    it("routes Lark tenants to the international host", () => {
        expect(feishuApiBase("lark")).toBe("https://open.larksuite.com");
        expect(feishuApiBase(undefined)).toBe("https://open.feishu.cn");
    });
});
