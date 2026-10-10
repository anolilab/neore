/**
 * Every adapter's media half: parsing attachments out of real webhook payload
 * shapes, downloading them from the platform's own hosts with the right
 * credential, and uploading files back through its media API. The platform
 * APIs are a stubbed `fetch` that records what was asked of them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutboundFile } from "../lib/media";
import { downloadDiscordAttachment, parseDiscordEvent, sendDiscordMedia } from "./discord";
import { downloadFeishuResource, forgetFeishuTokens, parseFeishuEnvelope, sendFeishuMedia } from "./feishu";
import { downloadLineContent, parseLineWebhook, sendLineMedia } from "./line";
import { downloadSlackFile, parseSlackEvent, sendSlackMedia } from "./slack";
import { downloadTeamsAttachment, forgetTeamsTokens, parseTeamsActivity, sendTeamsMedia } from "./teams";
import { downloadTelegramFile, parseTelegramUpdate, sendTelegramMedia } from "./telegram";
import { downloadWeChatMedia, forgetWeChatTokens, parseWeChatMessage, sendWeChatMedia } from "./wechat";
import { downloadWhatsAppMedia, parseWhatsAppWebhook, sendWhatsAppMedia } from "./whatsapp";

interface Call {
    authorization?: string;
    body?: BodyInit | null;
    method: string;
    url: string;
}

type Route = (url: string, call: Call) => Response | undefined;

/** Stub `fetch`: the first route that answers wins; an unrouted URL fails the test. */
const stubApis = (...routes: Route[]): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const call = { authorization: new Headers(init?.headers).get("authorization") ?? undefined, body: init?.body, method: init?.method ?? "GET", url };

        calls.push(call);

        for (const route of routes) {
            const response = route(url, call);

            if (response) {
                return response;
            }
        }

        throw new Error(`unexpected fetch: ${url}`);
    });

    return calls;
};

const on =
    (prefix: string, respond: (call: Call) => Response): Route =>
    (url, call) =>
        url.startsWith(prefix) ? respond(call) : undefined;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const bytes = (type: string) => new Response(PNG, { headers: { "content-type": type } });

const file = (mediaType: string, name = "chart.png"): OutboundFile => {
    return { bytes: new Uint8Array(PNG), mediaType, name, url: "https://backend.example/agent-files/abc?sig=1" };
};

const formOf = (call: Call | undefined): FormData => {
    if (!(call?.body instanceof FormData)) {
        throw new TypeError("expected a multipart body");
    }

    return call.body;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Telegram", () => {
    const update = (message: Record<string, unknown>) => {
        return {
            message: { chat: { id: 77, type: "private" }, date: 1_700_000_000, from: { first_name: "Ada", id: 42, is_bot: false }, message_id: 9, ...message },
            update_id: 1,
        };
    };

    it("parses a captioned photo (largest size that fits) and a voice note", () => {
        const photo = parseTelegramUpdate(
            update({
                caption: "what is this?",
                photo: [
                    { file_id: "small", file_size: 1000, file_unique_id: "s", height: 90, width: 90 },
                    { file_id: "large", file_size: 90_000, file_unique_id: "l", height: 1280, width: 1280 },
                ],
            }),
        );
        const voice = parseTelegramUpdate(update({ voice: { duration: 3, file_id: "voice", file_size: 4000, file_unique_id: "v", mime_type: "audio/ogg" } }));

        expect(photo).toMatchObject({ attachments: [{ kind: "image", ref: "large" }], kind: "media", text: "what is this?" });
        expect(voice).toMatchObject({ attachments: [{ kind: "voice", mimeType: "audio/ogg", ref: "voice" }], kind: "media" });
        expect(parseTelegramUpdate(update({ sticker: { file_id: "s" } }))?.kind).toBe("unsupported");
        expect(parseTelegramUpdate(update({ new_chat_members: [] }))).toBeNull();
    });

    it("resolves the file path, then downloads from the bot's file endpoint", async () => {
        const calls = stubApis(
            on("https://api.telegram.org/botTOKEN/getFile", () => Response.json({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 4 } })),
            on("https://api.telegram.org/file/botTOKEN/photos/file_1.jpg", () => bytes("application/octet-stream")),
        );

        const media = await downloadTelegramFile("TOKEN", { kind: "image", ref: "large" });

        expect(media.bytes).toHaveLength(4);
        expect(calls[0]?.url).toBe("https://api.telegram.org/botTOKEN/getFile?file_id=large");
    });

    it("uploads a PNG with sendPhoto and a PDF with sendDocument", async () => {
        const calls = stubApis(on("https://api.telegram.org/botTOKEN/", () => Response.json({ ok: true })));

        await sendTelegramMedia("TOKEN", "77", file("image/png"));
        await sendTelegramMedia("TOKEN", "77", file("application/pdf", "report.pdf"));

        expect(calls.map((call) => call.url)).toStrictEqual(["https://api.telegram.org/botTOKEN/sendPhoto", "https://api.telegram.org/botTOKEN/sendDocument"]);
        expect(formOf(calls[0]).get("chat_id")).toBe("77");
        expect(formOf(calls[1]).get("document")).toBeInstanceOf(Blob);
    });
});

describe("Slack", () => {
    const event = (fields: Record<string, unknown>) => {
        return { event: { channel: "D1", ts: "1700000000.000100", type: "message", user: "U1", ...fields }, type: "event_callback" };
    };

    it("reads a file_share message, caption optional, and ignores other subtypes", () => {
        const parsed = parseSlackEvent(
            event({
                files: [
                    {
                        id: "F1",
                        mimetype: "application/pdf",
                        name: "q3.pdf",
                        size: 2048,
                        url_private_download: "https://files.slack.com/files-pri/T1-F1/download/q3.pdf",
                    },
                ],
                subtype: "file_share",
                text: "",
            }),
        );

        expect(parsed && "message" in parsed && parsed.message).toMatchObject({
            attachments: [
                { kind: "file", mimeType: "application/pdf", name: "q3.pdf", ref: "https://files.slack.com/files-pri/T1-F1/download/q3.pdf", size: 2048 },
            ],
            kind: "media",
        });
        expect(parseSlackEvent(event({ subtype: "message_changed", text: "x" }))).toBeNull();
    });

    it("downloads with the bot token, and refuses a URL that is not Slack's", async () => {
        const calls = stubApis(on("https://files.slack.com/", () => bytes("application/pdf")));

        await downloadSlackFile("xoxb-1", { kind: "file", ref: "https://files.slack.com/files-pri/T1-F1/download/q3.pdf" });

        expect(calls[0]?.authorization).toBe("Bearer xoxb-1");
        await expect(downloadSlackFile("xoxb-1", { kind: "file", ref: "https://attacker.example/steal" })).rejects.toThrow("Refusing");
        expect(calls).toHaveLength(1);
    });

    it("uploads through getUploadURLExternal → upload URL → completeUploadExternal, into the thread", async () => {
        const calls = stubApis(
            on("https://slack.com/api/files.getUploadURLExternal", () =>
                Response.json({ file_id: "F9", ok: true, upload_url: "https://files.slack.com/upload/v1/abc" }),
            ),
            on("https://files.slack.com/upload/v1/abc", () => new Response("OK")),
            on("https://slack.com/api/files.completeUploadExternal", () => Response.json({ ok: true })),
        );

        await sendSlackMedia("xoxb-1", "D1", file("image/png"), "1700000000.000100");

        expect(calls.map((call) => call.url)).toStrictEqual([
            "https://slack.com/api/files.getUploadURLExternal",
            "https://files.slack.com/upload/v1/abc",
            "https://slack.com/api/files.completeUploadExternal",
        ]);
        expect(calls[1]?.authorization).toBeUndefined();
        expect(JSON.parse(String(calls[2]?.body))).toStrictEqual({
            channel_id: "D1",
            files: [{ id: "F9", title: "chart.png" }],
            thread_ts: "1700000000.000100",
        });
    });
});

describe("Discord", () => {
    it("reads gateway attachments, marking a voice message by its flag", () => {
        const parsed = parseDiscordEvent(
            {
                d: {
                    attachments: [
                        {
                            content_type: "audio/ogg",
                            filename: "voice-message.ogg",
                            id: "a1",
                            size: 9000,
                            url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1&is=2&hm=3",
                        },
                    ],
                    author: { id: "U1", username: "ada" },
                    channel_id: "C1",
                    content: "",
                    flags: 8192,
                    id: "m1",
                },
                t: "MESSAGE_CREATE",
            },
            1,
        );

        expect(parsed && "message" in parsed && parsed.message).toMatchObject({ attachments: [{ kind: "voice", mimeType: "audio/ogg" }], kind: "media" });
    });

    it("downloads from the CDN without the bot token and uploads with it", async () => {
        const calls = stubApis(
            on("https://cdn.discordapp.com/", () => bytes("image/png")),
            on("https://discord.com/api/v10/channels/C1/messages", () => Response.json({ id: "m2" })),
        );

        await downloadDiscordAttachment({ kind: "image", ref: "https://cdn.discordapp.com/attachments/1/2/a.png" });
        await sendDiscordMedia("BOT", "C1", file("image/png"));

        expect(calls[0]?.authorization).toBeUndefined();
        expect(calls[1]?.authorization).toBe("Bot BOT");
        expect(JSON.parse(String(formOf(calls[1]).get("payload_json")))).toStrictEqual({ attachments: [{ filename: "chart.png", id: 0 }] });
        await expect(downloadDiscordAttachment({ kind: "image", ref: "https://discord.attacker.example/a.png" })).rejects.toThrow("Refusing");
    });
});

describe("WhatsApp", () => {
    const PHONE_ID = "106540352242922";
    const webhook = (message: Record<string, unknown>) => {
        return {
            entry: [
                {
                    changes: [
                        {
                            field: "messages",
                            value: {
                                contacts: [{ profile: { name: "Ada" }, wa_id: "4915112345678" }],
                                messages: [{ from: "4915112345678", id: "wamid.X", timestamp: "1700000000", ...message }],
                                metadata: { phone_number_id: PHONE_ID },
                            },
                        },
                    ],
                },
            ],
            object: "whatsapp_business_account",
        };
    };

    it("reads a captioned image and a voice note", () => {
        const [image] = parseWhatsAppWebhook(webhook({ image: { caption: "look", id: "IMG", mime_type: "image/jpeg", sha256: "x" }, type: "image" }), PHONE_ID);
        const [voice] = parseWhatsAppWebhook(webhook({ audio: { id: "AUD", mime_type: "audio/ogg; codecs=opus", voice: true }, type: "audio" }), PHONE_ID);

        expect(image).toMatchObject({ attachments: [{ kind: "image", ref: "IMG" }], kind: "media", text: "look" });
        expect(voice).toMatchObject({ attachments: [{ kind: "voice", mimeType: "audio/ogg; codecs=opus", ref: "AUD" }], kind: "media" });
    });

    it("resolves the media URL, then downloads it from Meta's host only", async () => {
        const calls = stubApis(
            on("https://graph.facebook.com/v25.0/IMG", () =>
                Response.json({ file_size: 4, mime_type: "image/jpeg", url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=IMG" }),
            ),
            on("https://graph.facebook.com/v25.0/BAD", () => Response.json({ url: "https://attacker.example/x" })),
            on("https://lookaside.fbsbx.com/", () => bytes("image/jpeg")),
        );

        await downloadWhatsAppMedia("WA", { kind: "image", ref: "IMG" });

        expect(calls.map((call) => call.authorization)).toStrictEqual(["Bearer WA", "Bearer WA"]);
        await expect(downloadWhatsAppMedia("WA", { kind: "image", ref: "BAD" })).rejects.toThrow("Refusing");
        expect(calls.some((call) => call.url.startsWith("https://attacker.example"))).toBe(false);
    });

    it("uploads, then sends by media id — and reports a closed 24h window", async () => {
        let closed = false;
        const calls = stubApis(
            on(`https://graph.facebook.com/v25.0/${PHONE_ID}/media`, () => Response.json({ id: "MEDIA1" })),
            on(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, () =>
                closed
                    ? Response.json({ error: { code: 131_047, message: "Re-engagement message" } }, { status: 400 })
                    : Response.json({ messages: [{ id: "wamid.Y" }] }),
            ),
        );

        expect(await sendWhatsAppMedia("WA", PHONE_ID, "4915112345678", file("application/pdf", "q3.pdf"))).toBe("sent");
        expect(JSON.parse(String(calls[1]?.body))).toMatchObject({ document: { filename: "q3.pdf", id: "MEDIA1" }, type: "document" });

        closed = true;

        expect(await sendWhatsAppMedia("WA", PHONE_ID, "4915112345678", file("image/png"))).toBe("window_closed");
    });
});

describe("LINE", () => {
    const event = (message: Record<string, unknown>) => {
        return {
            message,
            mode: "active",
            replyToken: "rt",
            source: { type: "user", userId: "U1" },
            timestamp: 1_700_000_000_000,
            type: "message",
            webhookEventId: "01H",
        };
    };

    it("reads files and images, but not content hosted at the sender's own URL", () => {
        const [pdf] = parseLineWebhook({ events: [event({ fileName: "q3.pdf", fileSize: 2048, id: "M1", type: "file" })] });
        const [external] = parseLineWebhook({
            events: [event({ contentProvider: { originalContentUrl: "https://x.example/a.png", type: "external" }, id: "M2", type: "image" })],
        });

        expect(pdf).toMatchObject({ attachments: [{ kind: "file", name: "q3.pdf", ref: "M1", size: 2048 }], kind: "media" });
        expect(external?.kind).toBe("unsupported");
    });

    it("downloads from the data host with the channel token", async () => {
        const calls = stubApis(on("https://api-data.line.me/v2/bot/message/M1/content", () => bytes("application/pdf")));

        await downloadLineContent("LINE", { kind: "file", ref: "M1" });

        expect(calls[0]?.authorization).toBe("Bearer LINE");
    });

    it("pushes a small JPEG/PNG as an image message by URL; anything else is a link", async () => {
        const calls = stubApis(on("https://api.line.me/v2/bot/message/push", () => Response.json({})));

        expect(await sendLineMedia("LINE", "U1", file("image/png"))).toBe("sent");
        expect(JSON.parse(String(calls[0]?.body)).messages[0]).toStrictEqual({
            originalContentUrl: file("image/png").url,
            previewImageUrl: file("image/png").url,
            type: "image",
        });
        expect(await sendLineMedia("LINE", "U1", file("application/pdf", "q3.pdf"))).toBe("unsupported");
        expect(calls).toHaveLength(1);
    });
});

describe("Feishu", () => {
    const TOKEN = "verify";
    const envelope = (messageType: string, content: Record<string, string>) => {
        return {
            event: {
                message: { chat_id: "oc_1", content: JSON.stringify(content), create_time: "1700000000000", message_id: "om_1", message_type: messageType },
                sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
            },
            header: { create_time: "1700000000000", event_id: "ev_1", event_type: "im.message.receive_v1", token: TOKEN },
            schema: "2.0",
        };
    };
    const tenantToken = on("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", () =>
        Response.json({ code: 0, expire: 7200, tenant_access_token: "t-1" }),
    );

    afterEach(() => {
        forgetFeishuTokens("cli_1");
    });

    it("reads file and audio messages with their message id", () => {
        const fileMessage = parseFeishuEnvelope(envelope("file", { file_key: "file_v2_1", file_name: "q3.pdf" }), TOKEN);
        const audio = parseFeishuEnvelope(envelope("audio", { duration: "3000", file_key: "file_v2_2" }), TOKEN);

        expect(fileMessage?.kind === "message" && fileMessage.message.attachments).toStrictEqual([
            { kind: "file", messageId: "om_1", name: "q3.pdf", ref: "file_v2_1" },
        ]);
        expect(audio?.kind === "message" && audio.message.attachments).toStrictEqual([
            { kind: "voice", messageId: "om_1", mimeType: "audio/ogg", ref: "file_v2_2" },
        ]);
    });

    it("downloads a message resource with the tenant token", async () => {
        const calls = stubApis(
            tenantToken,
            on("https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_1?type=image", () => bytes("image/png")),
        );

        await downloadFeishuResource({ appId: "cli_1", appSecret: "s" }, { kind: "image", messageId: "om_1", ref: "img_1" });

        expect(calls[1]?.authorization).toBe("Bearer t-1");
    });

    it("uploads an image, then posts it by image_key", async () => {
        const calls = stubApis(
            tenantToken,
            on("https://open.feishu.cn/open-apis/im/v1/images", () => Response.json({ code: 0, data: { image_key: "img_up" } })),
            on("https://open.feishu.cn/open-apis/im/v1/messages", () => Response.json({ code: 0 })),
        );

        await sendFeishuMedia({ appId: "cli_1", appSecret: "s" }, "oc_1", file("image/png"));

        expect(formOf(calls[1]).get("image_type")).toBe("message");
        expect(JSON.parse(String(calls[2]?.body))).toStrictEqual({ content: JSON.stringify({ image_key: "img_up" }), msg_type: "image", receive_id: "oc_1" });
    });
});

describe("Teams", () => {
    const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
    const activity = (attachments: unknown[]) => {
        return {
            attachments,
            channelId: "msteams",
            conversation: { id: "a:1c" },
            from: { aadObjectId: "aad-1", id: "29:1" },
            id: "1700000000000",
            serviceUrl: SERVICE_URL,
            text: "",
            timestamp: "2023-11-14T22:13:20.000Z",
            type: "message",
        };
    };
    const connectorToken = on("https://login.microsoftonline.com/", () => Response.json({ access_token: "bf-token", expires_in: 3600 }));

    afterEach(() => {
        forgetTeamsTokens("app");
    });

    it("reads a shared file and a pasted image, skipping an image hosted anywhere else", () => {
        const parsed = parseTeamsActivity(
            activity([
                {
                    content: {
                        downloadUrl: "https://contoso-my.sharepoint.com/personal/ada/_layouts/15/download.aspx?share=x",
                        fileType: "pdf",
                        uniqueId: "u",
                    },
                    contentType: "application/vnd.microsoft.teams.file.download.info",
                    name: "q3.pdf",
                },
                { contentType: "image/png", contentUrl: `${SERVICE_URL}v3/attachments/0-abc/views/original` },
                { contentType: "image/png", contentUrl: "https://attacker.example/i.png" },
                { content: "<p>hi</p>", contentType: "text/html" },
            ]) as never,
        );

        expect(parsed?.attachments).toStrictEqual([
            { kind: "file", name: "q3.pdf", ref: "https://contoso-my.sharepoint.com/personal/ada/_layouts/15/download.aspx?share=x" },
            { kind: "image", mimeType: "image/png", name: undefined, ref: `${SERVICE_URL}v3/attachments/0-abc/views/original` },
        ]);
    });

    it("sends the connector token to the Bot Framework host only, and none to SharePoint", async () => {
        const calls = stubApis(
            connectorToken,
            on("https://smba.trafficmanager.net/", () => bytes("image/png")),
            on("https://contoso-my.sharepoint.com/", () => bytes("application/pdf")),
        );

        await downloadTeamsAttachment({ appId: "app", appPassword: "pw" }, { kind: "image", ref: `${SERVICE_URL}v3/attachments/0-abc/views/original` });
        await downloadTeamsAttachment({ appId: "app", appPassword: "pw" }, { kind: "file", ref: "https://contoso-my.sharepoint.com/download.aspx?x" });

        expect(calls.map((call) => [new URL(call.url).hostname, call.authorization])).toStrictEqual([
            ["login.microsoftonline.com", undefined],
            ["smba.trafficmanager.net", "Bearer bf-token"],
            ["contoso-my.sharepoint.com", undefined],
        ]);
        await expect(downloadTeamsAttachment({ appId: "app", appPassword: "pw" }, { kind: "image", ref: "https://attacker.example/i.png" })).rejects.toThrow(
            "untrusted",
        );
        await expect(downloadTeamsAttachment({ appId: "app", appPassword: "pw" }, { kind: "file", ref: "https://attacker.example/f.pdf" })).rejects.toThrow(
            "Refusing",
        );
    });

    it("sends an image as an inline attachment by URL; other files go as links", async () => {
        const calls = stubApis(
            connectorToken,
            on(`${SERVICE_URL}v3/conversations/`, () => Response.json({ id: "r1" })),
        );

        expect(await sendTeamsMedia({ appId: "app", appPassword: "pw" }, SERVICE_URL, "a:1c", "1700000000000", file("image/png"))).toBe("sent");
        expect(JSON.parse(String(calls[1]?.body)).attachments).toStrictEqual([
            { contentType: "image/png", contentUrl: file("image/png").url, name: "chart.png" },
        ]);
        expect(await sendTeamsMedia({ appId: "app", appPassword: "pw" }, SERVICE_URL, "a:1c", "1", file("application/pdf", "q3.pdf"))).toBe("unsupported");
    });
});

describe("WeChat", () => {
    const xml = (fields: string) =>
        `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[oUser]]></FromUserName><CreateTime>1700000000</CreateTime>${fields}<MsgId>1234567890123456</MsgId></xml>`;
    const accessToken = on("https://api.weixin.qq.com/cgi-bin/stable_token", () => Response.json({ access_token: "wx-token", expires_in: 7200 }));

    afterEach(() => {
        forgetWeChatTokens("wx1");
    });

    it("reads an image and a voice note with WeChat's own recognition", () => {
        const image = parseWeChatMessage(
            xml("<MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://mmbiz.qpic.cn/x]]></PicUrl><MediaId><![CDATA[MID1]]></MediaId>"),
        );
        const voice = parseWeChatMessage(
            xml(
                "<MsgType><![CDATA[voice]]></MsgType><MediaId><![CDATA[MID2]]></MediaId><Format><![CDATA[amr]]></Format><Recognition><![CDATA[你好]]></Recognition>",
            ),
        );

        expect(image).toMatchObject({ attachments: [{ kind: "image", ref: "MID1" }], kind: "media" });
        expect(voice).toMatchObject({ attachments: [{ kind: "voice", mimeType: "audio/amr", ref: "MID2", transcript: "你好" }], kind: "media" });
    });

    it("downloads temporary media, and treats a JSON answer as an error", async () => {
        stubApis(
            accessToken,
            on("https://api.weixin.qq.com/cgi-bin/media/get?access_token=wx-token&media_id=MID1", () => bytes("image/jpeg")),
            on("https://api.weixin.qq.com/cgi-bin/media/get?access_token=wx-token&media_id=GONE", () =>
                Response.json({ errcode: 40_007, errmsg: "invalid media_id" }),
            ),
        );

        await expect(downloadWeChatMedia({ appId: "wx1", appSecret: "s" }, { kind: "image", ref: "MID1" })).resolves.toMatchObject({
            contentType: "image/jpeg",
        });
        await expect(downloadWeChatMedia({ appId: "wx1", appSecret: "s" }, { kind: "image", ref: "GONE" })).rejects.toThrow("error");
    });

    it("uploads an image as temporary media and sends it; a PDF is a link", async () => {
        const calls = stubApis(
            accessToken,
            on("https://api.weixin.qq.com/cgi-bin/media/upload?access_token=wx-token&type=image", () => Response.json({ media_id: "UP1", type: "image" })),
            on("https://api.weixin.qq.com/cgi-bin/message/custom/send", () => Response.json({ errcode: 0 })),
        );

        expect(await sendWeChatMedia({ appId: "wx1", appSecret: "s" }, "oUser", file("image/png"))).toBe("sent");
        expect(JSON.parse(String(calls[2]?.body))).toStrictEqual({ image: { media_id: "UP1" }, msgtype: "image", touser: "oUser" });
        expect(await sendWeChatMedia({ appId: "wx1", appSecret: "s" }, "oUser", file("application/pdf", "q3.pdf"))).toBe("unsupported");
    });
});
