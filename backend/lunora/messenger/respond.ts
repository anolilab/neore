/**
 * Messenger AI response generator.
 *
 * Internal action that generates an AI response for a messenger thread
 * and sends it back to the platform: a headless run (`runHeadlessAgent`,
 * non-streaming, since messenger platforms don't support SSE) continuing the
 * messenger thread.
 *
 * A media message arrives here saved `pending` (the webhook reserved its place
 * in the thread): its attachments are downloaded, stored and transcribed first
 * (`messenger/media.ts`), and the row is completed with them. A burst of
 * messages gets one reply (`messenger_functions.claimThreadReply`), and none
 * while a media message is still pending — its own action answers once the
 * media is in, so "photo, then text" is one reply that sees the photo.
 *
 * Replies are text-only unless the owner enabled tools on the connection
 * (`lib/reply-tools.ts`): then the run gets the picked groups, is charged as one
 * headless round, and the images and files it produced are uploaded after the
 * text (`sendReplyMedia`).
 *
 * Bot tokens are fetched from the user's aiUserPreferences.messengerKeys (BYOK).
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import type { Delivery } from "./lib/platform-media";
import { requireKey } from "./lib/platform-media";
import type { ReplyToolPlan } from "./lib/reply-tools";
import { chooseReplyModel, MESSENGER_TEXT_REPLY_MAX_STEPS, MESSENGER_TOOL_REPLY_MAX_STEPS, MESSENGER_TOOL_SYSTEM, planReplyTools } from "./lib/reply-tools";
import { ingestAttachments, sendReplyMedia } from "./media";
import { sendDiscordMessage } from "./platforms/discord";
import { sendFeishuMessage } from "./platforms/feishu";
import { sendLineMessage } from "./platforms/line";
import { sendSlackMessage } from "./platforms/slack";
import { sendTeamsMessage } from "./platforms/teams";
import { sendTelegramMessage } from "./platforms/telegram";
import { sendWeChatMessage, WECHAT_SERVICE_WINDOW_MS } from "./platforms/wechat";
import { sendWhatsAppMessage, WHATSAPP_SERVICE_WINDOW_MS } from "./platforms/whatsapp";

export { MESSENGER_MEDIA_MODEL } from "./lib/reply-tools";

/** Sent instead of a model reply when nothing in a media message could be read. */
export const UNREADABLE_MEDIA_NOTICE =
    "I couldn't read what you sent — the file may be too large or of a type I don't support. Please try another file, or send your message as text.";

const vAttachment = v.object({
    kind: v.union(v.literal("audio"), v.literal("file"), v.literal("image"), v.literal("video"), v.literal("voice")),
    messageId: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    name: v.optional(v.string()),
    ref: v.string(),
    size: v.optional(v.number()),
    transcript: v.optional(v.string()),
});

/** Customer-service windows, per platform: a free-form reply after this long is refused. */
const REPLY_WINDOWS_MS: Partial<Record<string, number>> = {
    wechat: WECHAT_SERVICE_WINDOW_MS,
    whatsapp: WHATSAPP_SERVICE_WINDOW_MS,
};

const windowClosedNotice = (platform: string): string => {
    const hours = Math.round((REPLY_WINDOWS_MS[platform] ?? 0) / 3_600_000);
    const name = platform === "wechat" ? "WeChat" : "WhatsApp";

    return `This reply was not delivered: ${name} only allows free-form replies within ${String(hours)} hours of the sender's last message, and that window had closed. It reopens when they write again.`;
};

const isReplyWindowOpen = (delivery: Delivery, now: number = Date.now()): boolean => {
    const window = REPLY_WINDOWS_MS[delivery.platform];

    return window === undefined || delivery.inboundAt === undefined || now - delivery.inboundAt < window;
};

/**
 * Store a media message's attachments and complete its `pending` row. Always
 * completes the row — a failed download must not leave it pending, which would
 * hold back the thread's replies until it went stale. `false` when nothing in
 * it could be read.
 */
const completeMediaMessage = async (
    ctx: ActionCtx,
    options: {
        attachments: Parameters<typeof ingestAttachments>[1]["attachments"];
        caption?: string;
        keys: Record<string, string>;
        messageId: Id<"messages">;
        platform: string;
        threadId: Id<"threads">;
        userId: string;
    },
): Promise<boolean> => {
    const { messageId, ...ingestOptions } = options;

    try {
        const ingested = await ingestAttachments(ctx, ingestOptions);

        await ctx.runMutation(internal.messenger.functions.completeMessengerMessage, {
            fileIds: ingested.fileIds,
            messageId,
            parts: ingested.parts,
            text: ingested.text,
        });

        return ingested.hasContent;
    } catch (error) {
        await ctx.runMutation(internal.messenger.functions.completeMessengerMessage, { messageId, text: options.caption ?? "" });

        throw error;
    }
};

const vRespondArgs = {
    /** A media message's attachments; its `pending` row is completed here. */
    attachments: v.optional(v.array(vAttachment)),
    /** A media message's caption. */
    caption: v.optional(v.string()),
    inboundAt: v.optional(v.number()),
    /** The row the webhook saved for this message; absent for an unsupported one. */
    messageId: v.optional(v.id("messages")),
    /** Send this text instead of running the agent (e.g. "text only" for a voice note). */
    notice: v.optional(v.string()),
    platform: v.string(), // MessengerPlatform
    platformChatId: v.string(),
    platformThreadTs: v.optional(v.string()), // Slack thread timestamp
    replyToId: v.optional(v.string()), // Teams activity id
    replyToken: v.optional(v.string()), // LINE reply token
    serviceUrl: v.optional(v.string()), // Teams Bot Connector endpoint
    threadId: v.id("threads"),
    userId: v.string(),
};

export interface RespondArgs extends Delivery {
    attachments?: Parameters<typeof ingestAttachments>[1]["attachments"];
    caption?: string;
    messageId?: Id<"messages">;
    notice?: string;
    threadId: Id<"threads">;
    userId: string;
}

/**
 * The tools this reply may use: the thread's connection setting, charged as
 * one headless round. Refused by the quota — or for an owner who may not run
 * headless work — the reply still goes out, text only.
 */
const resolveReplyTools = async (ctx: ActionCtx, threadId: Id<"threads">, userId: string): Promise<ReplyToolPlan | null> => {
    const plan = planReplyTools(await ctx.runQuery(internal.messenger.functions.getReplyToolSetting, { threadId, userId }));

    if (!plan) {
        return null;
    }

    const charge = await ctx.runMutation(internal.messenger.functions.chargeReplyToolRound, { userId });

    if (charge !== "charged") {
        console.warn(`[Messenger] Reply tools skipped (${charge}); answering text only`);

        return null;
    }

    return plan;
};

/**
 * Run the agent for a reply. Memory is intentionally OFF for messenger
 * responses: the bot owner's stored memories are private to them, but
 * messenger senders are external platform users — leaking the owner's
 * memories to those senders would be a cross-user disclosure, and extracting
 * memories from third-party messages would let them poison the bot owner's
 * memory bank. Personalization (about-me, nickname, profession, custom
 * instructions, location) stays out for the same reason: the reply's reader
 * is not the owner.
 *
 * Tools come from the connection row alone (`lib/reply-tools.ts`), so nothing
 * the sender writes can widen them; the run is headless, so the owner's `ask`
 * tools are dropped, and every tool runs as the owner.
 */
const generateReply = async (ctx: ActionCtx, threadId: Id<"threads">, userId: string): Promise<{ replyTools: ReplyToolPlan | null; text: string }> => {
    const replyTools = await resolveReplyTools(ctx, threadId, userId);
    const hasMedia = await ctx.runQuery(internal.messenger.functions.threadHasRecentMedia, { threadId });
    const result = await runHeadlessAgent(ctx, {
        maxSteps: replyTools ? MESSENGER_TOOL_REPLY_MAX_STEPS : MESSENGER_TEXT_REPLY_MAX_STEPS,
        memory: false,
        model: chooseReplyModel({ hasMedia, tools: replyTools !== null }),
        personalization: "none",
        thread: { threadId },
        ...(replyTools
            ? {
                  additionalTools: replyTools.additionalTools,
                  system: MESSENGER_TOOL_SYSTEM,
                  toolAllowlist: replyTools.allowlist,
                  toolAllowlistKeepsMcp: replyTools.keepMcpTools,
                  tools: "headless" as const,
              }
            : { tools: "none" as const }),
        userId,
    });

    return { replyTools, text: result.text || "I couldn't generate a response. Please try again." };
};

/**
 * Upload the files a tool reply produced. A tool run can outlast the window it
 * started in, so the window is checked again before any upload; the platform
 * adapters still apply their own size limits.
 */
const sendToolReplyMedia = async (
    ctx: ActionCtx,
    options: { delivery: Delivery; keys: Record<string, string>; threadId: Id<"threads">; userId: string },
): Promise<"sent" | "window_closed"> => {
    const { delivery, keys } = options;

    if (!isReplyWindowOpen(delivery)) {
        return "window_closed";
    }

    return await sendReplyMedia(ctx, { ...options, sendText: async (text) => await sendPlatformMessage(delivery, text, keys) });
};

/**
 * Answer one inbound message: complete its media, then run the agent (with the
 * connection's tools when the owner enabled them) and send the text and any
 * files the reply produced. The body of {@link generateAndSendResponse}.
 */
export const respondToInbound = async (ctx: ActionCtx, args: RespondArgs): Promise<void> => {
    const { attachments, caption, messageId, notice, threadId, userId, ...delivery } = args;
    const { platform } = delivery;

    try {
        // Decrypt the user's messenger bot tokens (BYOK)
        const messengerKeys = await ctx.runQuery(internal.auth.functions.getDecryptedMessengerKeysQuery, {
            userId,
        });

        // A notice (unsupported content) answers this one message, no model run.
        let responseText = notice;
        const unreadableMedia =
            messageId !== undefined &&
            attachments !== undefined &&
            attachments.length > 0 &&
            !(await completeMediaMessage(ctx, { attachments, caption, keys: messengerKeys, messageId, platform, threadId, userId }));

        // Outside a customer-service window the platform will refuse the reply,
        // so do not spend the owner's model budget producing one.
        if (!isReplyWindowOpen(delivery)) {
            await ctx.runMutation(internal.messenger.functions.saveMessengerNotice, { text: windowClosedNotice(platform), threadId, userId });

            return;
        }

        if (responseText === undefined) {
            // One reply per burst, none while a media message is still being
            // stored — that message's own action answers once it is in.
            const claim = await ctx.runMutation(internal.messenger.functions.claimThreadReply, { threadId, userId });

            if (!claim.claimed) {
                return;
            }

            // Nothing readable, and nothing newer to answer: say so instead of a model run.
            if (unreadableMedia && claim.newestUserMessageId === messageId) {
                responseText = UNREADABLE_MEDIA_NOTICE;
            }
        }

        let replyTools: ReplyToolPlan | null = null;

        if (responseText === undefined) {
            ({ replyTools, text: responseText } = await generateReply(ctx, threadId, userId));
        }

        // Send response back to the platform using per-user BYOK tokens
        let outcome = await sendPlatformMessage(delivery, responseText, messengerKeys);

        // Only a reply with tools can have produced files.
        if (outcome === "sent" && replyTools) {
            outcome = await sendToolReplyMedia(ctx, { delivery, keys: messengerKeys, threadId, userId });
        }

        if (outcome === "window_closed") {
            await ctx.runMutation(internal.messenger.functions.saveMessengerNotice, { text: windowClosedNotice(platform), threadId, userId });
        }
    } catch (error) {
        console.error(`[Messenger] Failed to generate response for ${platform}:`, error);

        // Try to send an error message to the user
        const errorMessage = "Sorry, I encountered an error processing your message. Please try again.";

        try {
            const messengerKeys = await ctx.runQuery(internal.auth.functions.getDecryptedMessengerKeysQuery, {
                userId,
            });

            await sendPlatformMessage(delivery, errorMessage, messengerKeys);
        } catch {
            // If we can't even send the error message, just log it
            console.error(`[Messenger] Failed to send error message to ${platform}`);
        }
    }
};

export const generateAndSendResponse = internalAction
    .input(vRespondArgs)
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await respondToInbound(ctx, args);

        return null;
    });

/**
 * Send a fixed text with no thread and no model run — the pairing gate's
 * "paired" / "this bot is private" replies (`messenger/pairing.ts`). Failures are
 * logged and swallowed: a notice is a courtesy, never worth a retry storm.
 */
export const sendNotice = internalAction
    .input({
        inboundAt: v.optional(v.number()),
        platform: v.string(),
        platformChatId: v.string(),
        platformThreadTs: v.optional(v.string()),
        replyToId: v.optional(v.string()),
        replyToken: v.optional(v.string()),
        serviceUrl: v.optional(v.string()),
        text: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .action(async ({ args: { text, userId, ...delivery }, ctx }) => {
        if (!isReplyWindowOpen(delivery)) {
            return null;
        }

        try {
            const messengerKeys = await ctx.runQuery(internal.auth.functions.getDecryptedMessengerKeysQuery, { userId });

            await sendPlatformMessage(delivery, text, messengerKeys);
        } catch (error) {
            console.error(`[Messenger] Failed to send notice on ${delivery.platform}:`, error);
        }

        return null;
    });

/**
 * Route a message to the correct platform's send function.
 * Uses per-user decrypted bot tokens from messengerKeys.
 */
const sendPlatformMessage = async (delivery: Delivery, text: string, messengerKeys: Record<string, string>): Promise<"sent" | "window_closed"> => {
    const { platform, platformChatId: chatId } = delivery;

    switch (platform) {
        case "discord": {
            await sendDiscordMessage(requireKey(messengerKeys, "discord_bot_token", "Discord bot token"), chatId, text);

            return "sent";
        }
        case "feishu": {
            await sendFeishuMessage(
                {
                    appId: requireKey(messengerKeys, "feishu_app_id", "Feishu App ID"),
                    appSecret: requireKey(messengerKeys, "feishu_app_secret", "Feishu App Secret"),
                    domain: messengerKeys.feishu_domain,
                },
                chatId,
                text,
            );

            return "sent";
        }
        case "line": {
            await sendLineMessage(requireKey(messengerKeys, "line_channel_access_token", "LINE channel access token"), chatId, text, delivery.replyToken);

            return "sent";
        }
        case "slack": {
            await sendSlackMessage(requireKey(messengerKeys, "slack_bot_token", "Slack bot token"), chatId, text, delivery.platformThreadTs);

            return "sent";
        }
        case "teams": {
            if (!delivery.serviceUrl || !delivery.replyToId) {
                throw new Error("Teams reply needs the activity's serviceUrl and id");
            }

            await sendTeamsMessage(
                {
                    appId: requireKey(messengerKeys, "teams_app_id", "Teams App ID"),
                    appPassword: requireKey(messengerKeys, "teams_app_password", "Teams App password"),
                    tenantId: messengerKeys.teams_tenant_id,
                },
                delivery.serviceUrl,
                chatId,
                delivery.replyToId,
                text,
            );

            return "sent";
        }
        case "telegram": {
            await sendTelegramMessage(requireKey(messengerKeys, "telegram_bot_token", "Telegram bot token"), chatId, text);

            return "sent";
        }
        case "wechat": {
            return await sendWeChatMessage(
                {
                    appId: requireKey(messengerKeys, "wechat_app_id", "WeChat AppID"),
                    appSecret: requireKey(messengerKeys, "wechat_app_secret", "WeChat AppSecret"),
                },
                chatId,
                text,
            );
        }
        case "whatsapp": {
            return await sendWhatsAppMessage(
                requireKey(messengerKeys, "whatsapp_access_token", "WhatsApp access token"),
                requireKey(messengerKeys, "whatsapp_phone_number_id", "WhatsApp phone number ID"),
                chatId,
                text,
            );
        }
        default: {
            throw new Error(`Unknown platform: ${platform}`);
        }
    }
};

export default generateAndSendResponse;
