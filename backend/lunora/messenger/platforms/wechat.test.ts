import { describe, expect, it } from "vitest";

import { compareStrings } from "../../lib/collections";
import { base64ToBytes, bytesToBase64, digestHex } from "../../lib/crypto";
import { isFreshInbound } from "../lib/types";
import { decryptWeChatMessage, parseWeChatMessage, readXmlField, validateWeChatSignature } from "./wechat";

const TOKEN = "wechat-token";
const APP_ID = "wx5823bf96d3bd56c7";
/** 43 characters, as the console generates. */
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const NOW = 1_800_000_000_000;
const TIMESTAMP = String(NOW / 1000);
const NONCE = "1320562132";
const APP_ID_ERROR = /AppID/u;

const signature = async (...parts: string[]): Promise<string> => await digestHex("SHA-1", parts.toSorted(compareStrings).join(""));

/** WeChat's safe-mode encryption: random(16) | len(4, BE) | xml | appId, PKCS#7 to 32-byte blocks, AES-256-CBC. */
const encrypt = async (xml: string, appId = APP_ID): Promise<string> => {
    const raw = base64ToBytes(`${AES_KEY}=`);
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
    const body = new TextEncoder().encode(xml);
    const id = new TextEncoder().encode(appId);
    const unpadded = new Uint8Array(20 + body.length + id.length);

    unpadded.set(crypto.getRandomValues(new Uint8Array(16)));
    new DataView(unpadded.buffer).setUint32(16, body.length);
    unpadded.set(body, 20);
    unpadded.set(id, 20 + body.length);

    const pad = 32 - (unpadded.length % 32);
    const padded = new Uint8Array(unpadded.length + pad).fill(pad);

    padded.set(unpadded);

    // WebCrypto appends its own 16-byte padding block; CBC makes it droppable.
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ iv: raw.slice(0, 16), name: "AES-CBC" }, key, padded)).slice(0, padded.length);

    return bytesToBase64(ciphertext);
};

const textXml = (content: string, type = "text"): string =>
    `<xml><ToUserName><![CDATA[gh_abc]]></ToUserName><FromUserName><![CDATA[oUser]]></FromUserName><CreateTime>${TIMESTAMP}</CreateTime><MsgType><![CDATA[${type}]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>1234567890123456</MsgId></xml>`;

describe("validateWeChatSignature", () => {
    it("accepts the GET handshake signature", async () => {
        await expect(
            validateWeChatSignature({ nonce: NONCE, signature: await signature(TOKEN, TIMESTAMP, NONCE), timestamp: TIMESTAMP }, TOKEN, NOW),
        ).resolves.toBe(true);
    });

    it("accepts a msg_signature covering the ciphertext, and rejects it over another one", async () => {
        const encrypted = await encrypt(textXml("hi"));
        const messageSignature = await signature(TOKEN, TIMESTAMP, NONCE, encrypted);

        await expect(validateWeChatSignature({ encrypted, nonce: NONCE, signature: messageSignature, timestamp: TIMESTAMP }, TOKEN, NOW)).resolves.toBe(true);
        await expect(
            validateWeChatSignature({ encrypted: await encrypt(textXml("evil")), nonce: NONCE, signature: messageSignature, timestamp: TIMESTAMP }, TOKEN, NOW),
        ).resolves.toBe(false);
    });

    it("rejects the wrong token and missing parameters", async () => {
        const valid = await signature(TOKEN, TIMESTAMP, NONCE);

        await expect(validateWeChatSignature({ nonce: NONCE, signature: valid, timestamp: TIMESTAMP }, "other", NOW)).resolves.toBe(false);
        await expect(validateWeChatSignature({ nonce: null, signature: valid, timestamp: TIMESTAMP }, TOKEN, NOW)).resolves.toBe(false);
    });

    it("rejects a replayed request outside the five-minute window", async () => {
        const valid = await signature(TOKEN, TIMESTAMP, NONCE);

        await expect(validateWeChatSignature({ nonce: NONCE, signature: valid, timestamp: TIMESTAMP }, TOKEN, NOW + 5 * 60 * 1000 + 1000)).resolves.toBe(false);
    });
});

describe("decryptWeChatMessage", () => {
    it("round-trips safe-mode ciphertext, including pads longer than 16 bytes", async () => {
        // Vary the length so the 32-byte pad takes values above and below 16.
        for (const content of ["a", "hello world", "x".repeat(40), "你好，世界"]) {
            await expect(decryptWeChatMessage(await encrypt(textXml(content)), AES_KEY, APP_ID)).resolves.toBe(textXml(content));
        }
    });

    it("rejects a message encrypted for another AppID", async () => {
        await expect(decryptWeChatMessage(await encrypt(textXml("hi"), "wxother"), AES_KEY, APP_ID)).rejects.toThrow(APP_ID_ERROR);
    });

    it("rejects garbage", async () => {
        await expect(decryptWeChatMessage("AAAA", AES_KEY, APP_ID)).rejects.toThrow();
    });
});

describe("parseWeChatMessage", () => {
    it("parses a text message", () => {
        expect(parseWeChatMessage(textXml("Hello"))).toEqual({
            chatId: "oUser",
            eventId: "1234567890123456",
            kind: "text",
            senderId: "oUser",
            text: "Hello",
            timestampMs: NOW,
        });
    });

    it("marks voice and images unsupported and skips events", () => {
        expect(parseWeChatMessage(textXml("", "voice"))?.kind).toBe("unsupported");
        expect(parseWeChatMessage("<xml><MsgType><![CDATA[event]]></MsgType><FromUserName>o</FromUserName><Event>subscribe</Event></xml>")).toBeNull();
    });

    it("a replayed message past the window is not fresh", () => {
        const message = parseWeChatMessage(textXml("Hello"))!;

        expect(isFreshInbound(message, 5 * 60 * 1000, NOW + 5 * 60 * 1000 + 1)).toBe(false);
    });

    it("reads plain and CDATA fields", () => {
        expect(readXmlField("<xml><A>1</A><B><![CDATA[<b>]]></B></xml>", "A")).toBe("1");
        expect(readXmlField("<xml><A>1</A><B><![CDATA[<b>]]></B></xml>", "B")).toBe("<b>");
        expect(readXmlField("<xml></xml>", "A")).toBeUndefined();
    });
});
