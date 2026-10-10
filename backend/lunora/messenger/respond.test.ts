/**
 * The reply action with tools on and off. The agent run, the platform adapters'
 * network calls and storage are faked; the tool plan, the billing charge, the
 * media routing (`lib/platform-media.ts`) and the reply windows are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../test/registered-api";

import { MESSENGER_MEDIA_MODEL, MESSENGER_TOOL_REPLY_MAX_STEPS, MESSENGER_TOOL_SYSTEM } from "./lib/reply-tools";

// A reference is read as its dispatch key, which the fake ctx below switches on.
vi.mock("../_generated/api", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));
vi.mock("../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const state = vi.hoisted(() => {
    return {
        afterRun: undefined as (() => void) | undefined,
        charge: "charged" as "charged" | "limit" | "unavailable",
        mutations: [] as { args: unknown; path: string }[],
        replyFiles: [] as { filename?: string; key: string; mediaType: string }[],
        runs: [] as Record<string, unknown>[],
        sentMedia: [] as { chatId: string; mediaType: string; platform: string }[],
        sentText: [] as { chatId: string; platform: string; text: string }[],
        setting: null as { enabled: boolean; groups?: string[] } | null,
        settingArgs: [] as unknown[],
    };
});

vi.mock("../chat/lib/headless-run", () => {
    return {
        runHeadlessAgent: async (_ctx: unknown, options: Record<string, unknown>) => {
            state.runs.push(options);
            state.afterRun?.();

            return { text: "Here is your picture.", threadId: "thread-1" };
        },
    };
});

vi.mock("./platforms/telegram", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./platforms/telegram")>()),
        sendTelegramMedia: async (_token: string, chatId: string, file: { mediaType: string }) => {
            state.sentMedia.push({ chatId, mediaType: file.mediaType, platform: "telegram" });

            return "sent";
        },
        sendTelegramMessage: async (_token: string, chatId: string, text: string) => {
            state.sentText.push({ chatId, platform: "telegram", text });

            return true;
        },
    };
});

vi.mock("./platforms/whatsapp", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./platforms/whatsapp")>()),
        sendWhatsAppMedia: async (_token: string, _phone: string, chatId: string, file: { mediaType: string }) => {
            state.sentMedia.push({ chatId, mediaType: file.mediaType, platform: "whatsapp" });

            return "sent";
        },
        sendWhatsAppMessage: async (_token: string, _phone: string, chatId: string, text: string) => {
            state.sentText.push({ chatId, platform: "whatsapp", text });

            return "sent";
        },
    };
});

vi.mock("./platforms/wechat", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./platforms/wechat")>()),
        sendWeChatMedia: async (_credentials: unknown, chatId: string, file: { mediaType: string }) => {
            state.sentMedia.push({ chatId, mediaType: file.mediaType, platform: "wechat" });

            return "sent";
        },
        sendWeChatMessage: async (_credentials: unknown, chatId: string, text: string) => {
            state.sentText.push({ chatId, platform: "wechat", text });

            return "sent";
        },
    };
});

vi.mock("../lib/storage-read", () => {
    return {
        readStoredObject: async () => {
            return { bytes: new Uint8Array([137, 80, 78, 71]).buffer };
        },
        signedReadUrl: async (_storage: unknown, key: string) => `https://signed.example/${key}`,
    };
});

const { respondToInbound } = await import("./respond");

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const KEYS = { telegram_bot_token: "tg", wechat_app_id: "wx", wechat_app_secret: "wx-secret", whatsapp_access_token: "wa", whatsapp_phone_number_id: "phone" };

const ctx = () =>
    ({
        runMutation: async (path: string, args: unknown) => {
            state.mutations.push({ args, path });

            switch (path) {
                case "messenger_functions:chargeReplyToolRound": {
                    return state.charge;
                }
                case "messenger_functions:claimThreadReply": {
                    return { claimed: true };
                }
                default: {
                    return null;
                }
            }
        },
        runQuery: async (path: string, args: unknown) => {
            switch (path) {
                case "auth_functions:getDecryptedMessengerKeysQuery": {
                    return KEYS;
                }
                case "messenger_functions:getReplyToolSetting": {
                    state.settingArgs.push(args);

                    return state.setting;
                }
                case "messenger_functions:listReplyMedia": {
                    return state.replyFiles;
                }
                case "messenger_functions:threadHasRecentMedia": {
                    return false;
                }
                default: {
                    throw new Error(`unexpected query ${path}`);
                }
            }
        },
        storage: {},
    }) as never;

const respond = async (fields: { inboundAt?: number; platform?: string } = {}) =>
    await respondToInbound(ctx(), {
        inboundAt: fields.inboundAt ?? NOW - 1000,
        platform: fields.platform ?? "telegram",
        platformChatId: "chat-1",
        threadId: "thread-1" as never,
        userId: "owner",
    });

const mutationPaths = () => state.mutations.map((entry) => entry.path);

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    state.afterRun = undefined;
    state.charge = "charged";
    state.mutations = [];
    state.replyFiles = [{ filename: "cat.png", key: "agent-files/cat", mediaType: "image/png" }];
    state.runs = [];
    state.sentMedia = [];
    state.sentText = [];
    state.setting = null;
    state.settingArgs = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("messenger replies without tools", () => {
    it("run text-only on the default model, uncharged, and send no files", async () => {
        await respond();

        expect(state.runs).toHaveLength(1);
        expect(state.runs[0]).toMatchObject({ maxSteps: 3, memory: false, personalization: "none", tools: "none" });
        expect(state.runs[0]!.model).not.toBe(MESSENGER_MEDIA_MODEL);
        expect(state.runs[0]!.toolAllowlist).toBeUndefined();
        expect(mutationPaths()).not.toContain("messenger_functions:chargeReplyToolRound");
        expect(state.sentText).toStrictEqual([{ chatId: "chat-1", platform: "telegram", text: "Here is your picture." }]);
        expect(state.sentMedia).toStrictEqual([]);
    });

    it("stay text-only when the owner enabled tools but picked no group", async () => {
        state.setting = { enabled: true, groups: [] };

        await respond();

        expect(state.runs[0]).toMatchObject({ tools: "none" });
        expect(mutationPaths()).not.toContain("messenger_functions:chargeReplyToolRound");
    });
});

describe("messenger replies with tools", () => {
    it("run headless on the tool model, narrowed to the picked groups, capped and charged once", async () => {
        state.setting = { enabled: true, groups: ["webSearch", "imageGeneration"] };

        await respond();

        expect(state.runs[0]).toMatchObject({
            additionalTools: ["imageGeneration"],
            maxSteps: MESSENGER_TOOL_REPLY_MAX_STEPS,
            memory: false,
            model: MESSENGER_MEDIA_MODEL,
            personalization: "none",
            system: MESSENGER_TOOL_SYSTEM,
            toolAllowlist: ["webSearch", "imageGeneration"],
            toolAllowlistKeepsMcp: false,
            // Headless: the owner's `ask` tools are dropped by the permission layer.
            tools: "headless",
            userId: "owner",
        });
        expect(state.mutations.filter((entry) => entry.path === "messenger_functions:chargeReplyToolRound")).toStrictEqual([
            { args: { userId: "owner" }, path: "messenger_functions:chargeReplyToolRound" },
        ]);
    });

    it("read the setting by thread and owner only — never from the message", async () => {
        state.setting = { enabled: true };

        await respond();

        expect(state.settingArgs).toStrictEqual([{ threadId: "thread-1", userId: "owner" }]);
    });

    it("upload a generated image through the platform adapter after the text", async () => {
        state.setting = { enabled: true, groups: ["imageGeneration"] };

        await respond();

        expect(state.sentText.map((entry) => entry.text)).toStrictEqual(["Here is your picture."]);
        expect(state.sentMedia).toStrictEqual([{ chatId: "chat-1", mediaType: "image/png", platform: "telegram" }]);
    });

    it.each(["limit", "unavailable"] as const)("answer text-only when the round is refused (%s)", async (charge) => {
        state.setting = { enabled: true };
        state.charge = charge;

        await respond();

        expect(state.runs[0]).toMatchObject({ tools: "none" });
        expect(state.sentText).toHaveLength(1);
        expect(state.sentMedia).toStrictEqual([]);
    });
});

describe("reply windows", () => {
    it("run nothing and charge nothing once WhatsApp's 24h window has closed", async () => {
        state.setting = { enabled: true };

        await respond({ inboundAt: NOW - 25 * HOUR, platform: "whatsapp" });

        expect(state.runs).toStrictEqual([]);
        expect(mutationPaths()).toStrictEqual(["messenger_functions:saveMessengerNotice"]);
        expect(state.sentText).toStrictEqual([]);
    });

    it("send no files when the window closed while the tools ran", async () => {
        state.setting = { enabled: true };
        state.afterRun = () => {
            vi.setSystemTime(NOW + 2 * HOUR);
        };

        await respond({ inboundAt: NOW - 23 * HOUR, platform: "whatsapp" });

        expect(state.sentMedia).toStrictEqual([]);
        expect(mutationPaths()).toContain("messenger_functions:saveMessengerNotice");
    });

    it("still upload within WeChat's 48h window, past WhatsApp's 24h", async () => {
        state.setting = { enabled: true, groups: ["imageGeneration"] };

        await respond({ inboundAt: NOW - 30 * HOUR, platform: "wechat" });

        expect(state.runs).toHaveLength(1);
        expect(state.sentMedia).toStrictEqual([{ chatId: "chat-1", mediaType: "image/png", platform: "wechat" }]);
    });
});
