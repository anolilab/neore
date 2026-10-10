/**
 * Discord Interactions API utilities for messenger integration.
 *
 * Handles Ed25519 signature validation, interaction parsing, and
 * sending messages back to Discord channels.
 * @see https://discord.com/developers/docs/interactions/overview
 * @see https://discord.com/developers/docs/resources/channel#create-message
 */

import { isWithinWindow, SIGNED_REQUEST_WINDOW_MS } from "../../lib/crypto";
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk, fetchWithDeadline } from "../../lib/fetch-timeout";
import type { AttachmentKind, DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

/** Discord's attachment CDN; its URLs are signed and need no bot token. */
const DISCORD_CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];

/** `flags` bit of a voice message. */
const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;

interface DiscordAttachment {
    content_type?: string;
    filename?: string;
    id?: string;
    size?: number;
    url?: string;
}

/** Discord Interaction payload (simplified) */
interface DiscordInteraction {
    channel_id?: string;
    data?: {
        name?: string;
        /** Option type 11 is an attachment; its value is an id into `resolved.attachments`. */
        options?: { name: string; type?: number; value: string }[];
        resolved?: { attachments?: Record<string, DiscordAttachment> };
    };
    guild_id?: string;
    id: string;
    member?: {
        user: { id: string; username: string };
    };
    message?: {
        author: { bot?: boolean; id: string; username: string };
        channel_id: string;
        content: string;
        id: string;
    };
    token: string;
    type: number; // 1 = PING, 2 = APPLICATION_COMMAND, etc.
    user?: { id: string; username: string }; // DM context
}

/** Discord Gateway message event (for bot messages in channels) */
interface DiscordGatewayMessage {
    d?: {
        attachments?: DiscordAttachment[];
        author: {
            bot?: boolean;
            id: string;
            username: string;
        };
        channel_id: string;
        content: string;
        flags?: number;
        guild_id?: string;
        id: string;
        // We check for mentions of our bot
        mentions?: { bot?: boolean; id: string; username: string }[];
    };
    t?: string; // "MESSAGE_CREATE"
}

/** The signed timestamp of a Discord request, in ms (0 when absent, which no window accepts). */
export const discordSignedAt = (request: Request): number => Number(request.headers.get("x-signature-timestamp")) * 1000;

/**
 * Validate a Discord interaction request using its Ed25519 signature over
 * `timestamp + body`, refusing a request signed outside the replay window — the
 * signature alone would let a captured request replay forever.
 * @see https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint
 */
export const validateDiscordSignature = async (request: Request, body: string, publicKey: string): Promise<boolean> => {
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");

    if (!signature || !timestamp || !isWithinWindow(discordSignedAt(request), SIGNED_REQUEST_WINDOW_MS)) {
        return false;
    }

    try {
        const keyBytes = hexToBytes(publicKey);
        const key = await crypto.subtle.importKey("raw", keyBytes as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);

        const signatureBytes = hexToBytes(signature);
        const messageBytes = new TextEncoder().encode(timestamp + body);

        return await crypto.subtle.verify("Ed25519", key, signatureBytes as unknown as BufferSource, messageBytes);
    } catch {
        return false;
    }
};

const discordKind = (attachment: DiscordAttachment, isVoiceMessage: boolean): AttachmentKind => {
    if (isVoiceMessage) {
        return "voice";
    }

    if (attachment.content_type?.startsWith("image/")) {
        return "image";
    }

    return attachment.content_type?.startsWith("audio/") ? "audio" : "file";
};

const toDiscordAttachments = (attachments: ReadonlyArray<DiscordAttachment>, isVoiceMessage = false): InboundAttachment[] =>
    attachments.flatMap((attachment) =>
        attachment.url
            ? [
                  {
                      kind: discordKind(attachment, isVoiceMessage),
                      mimeType: attachment.content_type,
                      name: attachment.filename,
                      ref: attachment.url,
                      ...(attachment.size !== undefined && { size: attachment.size }),
                  },
              ]
            : [],
    );

/**
 * Parse a Discord interaction or gateway message event into the shared inbound
 * shape. Neither carries a send time we can trust as much as the signed request
 * timestamp, so `signedAtMs` (from {@link discordSignedAt}) is the message time.
 * Returns null for bot messages; PINGs return { pong: true }.
 */
export const parseDiscordEvent = (body: unknown, signedAtMs: number): { message: InboundMessage } | { pong: true } | null => {
    const payload = body as (DiscordGatewayMessage & DiscordInteraction) | null;

    if (!payload) {
        return null;
    }

    // Handle PING (type 1) — Discord verification
    if (payload.type === 1) {
        return { pong: true };
    }

    // Handle gateway MESSAGE_CREATE events
    if (payload.t === "MESSAGE_CREATE" && payload.d) {
        const { d: data } = payload;

        const attachments = toDiscordAttachments(data.attachments ?? [], ((data.flags ?? 0) & DISCORD_VOICE_MESSAGE_FLAG) !== 0);

        // Ignore bot messages
        if (data.author.bot || (!data.content && attachments.length === 0)) {
            return null;
        }

        return {
            message: {
                ...(attachments.length > 0 && { attachments }),
                chatId: data.channel_id,
                eventId: data.id,
                kind: inboundKind(data.content, attachments),
                senderId: data.author.id,
                senderUsername: data.author.username,
                text: data.content || undefined,
                timestampMs: signedAtMs,
            },
        };
    }

    // Handle slash command interactions (type 2)
    if (payload.type === 2 && payload.data) {
        const user = payload.member?.user || payload.user;

        if (!user) {
            return null;
        }

        // Extract text from command options
        const textOption = payload.data.options?.find((o) => o.name === "message");
        const resolved = payload.data.resolved?.attachments ?? {};
        const attachments = toDiscordAttachments(
            (payload.data.options ?? []).flatMap((option) => (option.type === 11 && resolved[option.value] ? [resolved[option.value]!] : [])),
        );

        return {
            message: {
                ...(attachments.length > 0 && { attachments }),
                chatId: payload.channel_id || "",
                eventId: payload.id,
                kind: attachments.length > 0 ? "media" : "text",
                senderId: user.id,
                senderUsername: user.username,
                text: textOption?.value || payload.data.name || "",
                timestampMs: signedAtMs,
            },
        };
    }

    return null;
};

/**
 * Send a message to a Discord channel via REST API.
 */
export const sendDiscordMessage = async (botToken: string, channelId: string, text: string): Promise<boolean> => {
    // Discord messages max 2000 chars; split if needed
    const chunks = splitMessage(text, 2000);

    for (const chunk of chunks) {
        const response = await fetchWithDeadline(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            body: JSON.stringify({ content: chunk }),
            headers: {
                Authorization: `Bot ${botToken}`,
                "Content-Type": "application/json",
            },
            method: "POST",
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        if (!response.ok) {
            const errorBody = await response.text();

            console.error(`Discord sendMessage failed: ${response.status} ${errorBody}`);

            return false;
        }
    }

    return true;
};

/** Download an attachment from Discord's CDN (signed URLs; the bot token is not sent). */
export const downloadDiscordAttachment = async (attachment: InboundAttachment): Promise<DownloadedMedia> =>
    await fetchMedia(attachment.ref, { allowedHosts: DISCORD_CDN_HOSTS });

/** Post a file into the channel as a message attachment (multipart). */
export const sendDiscordMedia = async (botToken: string, channelId: string, file: OutboundFile): Promise<MediaSendResult> => {
    const form = new FormData();

    form.set("payload_json", JSON.stringify({ attachments: [{ filename: file.name, id: 0 }] }));
    form.set("files[0]", toBlob(file), file.name);

    const response = await fetchOk(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        body: form,
        errorPrefix: "Discord file upload failed",
        headers: { Authorization: `Bot ${botToken}` },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });

    await response.body?.cancel();

    return "sent";
};

/** Convert hex string to Uint8Array. */
const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);

    for (let index = 0; index < hex.length; index += 2) {
        bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
    }

    return bytes;
};
