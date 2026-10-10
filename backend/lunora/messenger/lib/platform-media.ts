/**
 * Route a media download or upload to its platform adapter, with the owner's
 * decrypted messenger keys (BYOK). The adapters hold the host rules; this only
 * picks the adapter and the keys it needs.
 */
import { downloadDiscordAttachment, sendDiscordMedia } from "../platforms/discord";
import { downloadFeishuResource, sendFeishuMedia } from "../platforms/feishu";
import { downloadLineContent, sendLineMedia } from "../platforms/line";
import { downloadSlackFile, sendSlackMedia } from "../platforms/slack";
import { downloadTeamsAttachment, sendTeamsMedia } from "../platforms/teams";
import { downloadTelegramFile, sendTelegramMedia } from "../platforms/telegram";
import { downloadWeChatMedia, sendWeChatMedia } from "../platforms/wechat";
import { downloadWhatsAppMedia, sendWhatsAppMedia } from "../platforms/whatsapp";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "./media";

/** Where a reply goes and what the platform needs to address it. */
export interface Delivery {
    /** When the sender's message was sent (ms) — WhatsApp and WeChat only allow replies within a window of it. */
    inboundAt?: number;
    platform: string;
    platformChatId: string;
    platformThreadTs?: string;
    replyToId?: string;
    replyToken?: string;
    serviceUrl?: string;
}

export const requireKey = (keys: Record<string, string>, id: string, label: string): string => {
    const value = keys[id];

    if (!value) {
        throw new Error(`${label} not configured`);
    }

    return value;
};

const feishuCredentials = (keys: Record<string, string>) => {
    return {
        appId: requireKey(keys, "feishu_app_id", "Feishu App ID"),
        appSecret: requireKey(keys, "feishu_app_secret", "Feishu App Secret"),
        domain: keys.feishu_domain,
    };
};

const teamsCredentials = (keys: Record<string, string>) => {
    return {
        appId: requireKey(keys, "teams_app_id", "Teams App ID"),
        appPassword: requireKey(keys, "teams_app_password", "Teams App password"),
        tenantId: keys.teams_tenant_id,
    };
};

const weChatCredentials = (keys: Record<string, string>) => {
    return {
        appId: requireKey(keys, "wechat_app_id", "WeChat AppID"),
        appSecret: requireKey(keys, "wechat_app_secret", "WeChat AppSecret"),
    };
};

/** Fetch an inbound attachment's bytes from its platform. Throws on any failure. */
export const downloadAttachment = async (platform: string, keys: Record<string, string>, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    switch (platform) {
        case "discord": {
            return await downloadDiscordAttachment(attachment);
        }
        case "feishu": {
            return await downloadFeishuResource(feishuCredentials(keys), attachment);
        }
        case "line": {
            return await downloadLineContent(requireKey(keys, "line_channel_access_token", "LINE channel access token"), attachment);
        }
        case "slack": {
            return await downloadSlackFile(requireKey(keys, "slack_bot_token", "Slack bot token"), attachment);
        }
        case "teams": {
            return await downloadTeamsAttachment(teamsCredentials(keys), attachment);
        }
        case "telegram": {
            return await downloadTelegramFile(requireKey(keys, "telegram_bot_token", "Telegram bot token"), attachment);
        }
        case "wechat": {
            return await downloadWeChatMedia(weChatCredentials(keys), attachment);
        }
        case "whatsapp": {
            return await downloadWhatsAppMedia(requireKey(keys, "whatsapp_access_token", "WhatsApp access token"), attachment);
        }
        default: {
            throw new Error(`Unknown platform: ${platform}`);
        }
    }
};

/**
 * Send one file through the platform's own media API. `"unsupported"` when
 * the platform cannot take this kind of file (the caller sends a link instead);
 * throws when the upload fails.
 */
export const sendPlatformMedia = async (delivery: Delivery, file: OutboundFile, keys: Record<string, string>): Promise<MediaSendResult> => {
    const { platform, platformChatId: chatId } = delivery;

    switch (platform) {
        case "discord": {
            return await sendDiscordMedia(requireKey(keys, "discord_bot_token", "Discord bot token"), chatId, file);
        }
        case "feishu": {
            return await sendFeishuMedia(feishuCredentials(keys), chatId, file);
        }
        case "line": {
            return await sendLineMedia(requireKey(keys, "line_channel_access_token", "LINE channel access token"), chatId, file);
        }
        case "slack": {
            return await sendSlackMedia(requireKey(keys, "slack_bot_token", "Slack bot token"), chatId, file, delivery.platformThreadTs);
        }
        case "teams": {
            if (!delivery.serviceUrl || !delivery.replyToId) {
                throw new Error("Teams reply needs the activity's serviceUrl and id");
            }

            return await sendTeamsMedia(teamsCredentials(keys), delivery.serviceUrl, chatId, delivery.replyToId, file);
        }
        case "telegram": {
            return await sendTelegramMedia(requireKey(keys, "telegram_bot_token", "Telegram bot token"), chatId, file);
        }
        case "wechat": {
            return await sendWeChatMedia(weChatCredentials(keys), chatId, file);
        }
        case "whatsapp": {
            return await sendWhatsAppMedia(
                requireKey(keys, "whatsapp_access_token", "WhatsApp access token"),
                requireKey(keys, "whatsapp_phone_number_id", "WhatsApp phone number ID"),
                chatId,
                file,
            );
        }
        default: {
            throw new Error(`Unknown platform: ${platform}`);
        }
    }
};
