/**
 * Slack Events API utilities for messenger integration.
 *
 * Handles webhook signature validation, event parsing, and sending
 * messages back to Slack channels/threads.
 * @see https://api.slack.com/events-api
 * @see https://api.slack.com/methods/chat.postMessage
 */

import { hmacSha256Hex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, timingSafeEqual } from "../../lib/crypto";
import { FETCH_TIMEOUT_LONG_MS, FETCH_TIMEOUT_SHORT_MS, fetchOk, fetchWithDeadline } from "../../lib/fetch-timeout";
import type { AttachmentKind, DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia, isAllowedHost, toBlob } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind } from "../lib/types";

/** Slack serves files from `files.slack.com` and may redirect within its own domains. */
const SLACK_FILE_HOSTS = [".slack.com", ".slack-edge.com"];

/**
 * How old a message may be and still be answered. Slack retries a failed
 * delivery three times over a few minutes; anything older is a replay.
 */
export const SLACK_EVENT_MAX_AGE_MS = 60 * 60 * 1000;

/** A Slack message in the shared inbound shape, plus the thread it replies into. */
export interface SlackInboundMessage extends InboundMessage {
    /** The thread a reply goes into: the message's own thread, else the message itself. */
    threadTs: string;
}

interface SlackFile {
    id?: string;
    mimetype?: string;
    name?: string;
    size?: number;
    /** `slack_audio` for a recorded clip. */
    subtype?: string;
    url_private_download?: string;
}

/** Slack Events API payload (simplified) */
interface SlackEventPayload {
    challenge?: string; // URL verification challenge
    event?: {
        bot_id?: string; // Present if message is from a bot
        channel?: string;
        files?: SlackFile[];
        subtype?: string; // "bot_message", "message_changed", etc.
        text?: string;
        thread_ts?: string;
        ts?: string;
        type: string; // "message" | "app_mention"
        user?: string;
    };
    team_id?: string;
    token?: string;
    type: string; // "url_verification" | "event_callback"
}

/**
 * Validate Slack request signature using HMAC-SHA256, refusing a request
 * signed outside the replay window.
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export const validateSlackSignature = async (request: Request, body: string, signingSecret: string): Promise<boolean> => {
    const signature = request.headers.get("x-slack-signature");
    const timestamp = request.headers.get("x-slack-request-timestamp");

    if (!signature || !timestamp || !isWithinWindow(Number.parseInt(timestamp, 10) * 1000, SIGNED_REQUEST_WINDOW_MS)) {
        return false;
    }

    return timingSafeEqual(signature, `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${body}`)}`);
};

const slackKind = (file: SlackFile): AttachmentKind => {
    if (file.subtype === "slack_audio") {
        return "voice";
    }

    if (file.mimetype?.startsWith("image/")) {
        return "image";
    }

    return file.mimetype?.startsWith("audio/") ? "audio" : "file";
};

/** The event's uploads that Slack lets a bot download; `url_private_download` needs the bot token (scope `files:read`). */
const slackAttachments = (files: SlackFile[] | undefined): InboundAttachment[] =>
    (files ?? []).flatMap((file) => {
        const url = file.url_private_download;

        return url ? [{ kind: slackKind(file), mimeType: file.mimetype, name: file.name, ref: url, ...(file.size !== undefined && { size: file.size }) }] : [];
    });

/**
 * Parse a Slack Events API payload.
 * Returns null for bot messages, subtypes, or non-message events.
 * Returns { challenge } for URL verification.
 */
export const parseSlackEvent = (body: unknown): { challenge: string } | { message: SlackInboundMessage } | null => {
    const payload = body as SlackEventPayload | null;

    if (!payload) {
        return null;
    }

    // Handle URL verification challenge
    if (payload.type === "url_verification" && payload.challenge) {
        return { challenge: payload.challenge };
    }

    if (payload.type !== "event_callback" || !payload.event) {
        return null;
    }

    const { event } = payload;

    const attachments = slackAttachments(event.files);

    // Ignore bot messages, message edits, and non-message events. `file_share`
    // is the one subtype read: a message that carries uploads.
    if (event.bot_id || (event.subtype && event.subtype !== "file_share") || !event.user || (!event.text && attachments.length === 0) || !event.channel) {
        return null;
    }

    // Only handle direct messages and app mentions
    if (event.type !== "message" && event.type !== "app_mention") {
        return null;
    }

    const eventTs = event.ts || "";

    return {
        message: {
            ...(attachments.length > 0 && { attachments }),
            chatId: event.channel,
            eventId: `${event.channel}:${eventTs}`,
            kind: inboundKind(event.text, attachments),
            senderId: event.user,
            text: event.text || undefined,
            threadTs: event.thread_ts || eventTs,
            // `ts` is "<unix seconds>.<sequence>".
            timestampMs: Number(eventTs) * 1000,
        },
    };
};

/**
 * Send a message to a Slack channel via the Web API.
 */
export const sendSlackMessage = async (botToken: string, channelId: string, text: string, threadTs?: string): Promise<boolean> => {
    const response = await fetchWithDeadline("https://slack.com/api/chat.postMessage", {
        body: JSON.stringify({
            channel: channelId,
            text,
            ...(threadTs && { thread_ts: threadTs }),
        }),
        headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json",
        },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });

    if (!response.ok) {
        await response.body?.cancel();

        console.error(`Slack postMessage failed: ${response.status}`);

        return false;
    }

    const result = (await response.json()) as { error?: string; ok: boolean };

    if (!result.ok) {
        console.error(`Slack API error: ${result.error}`);

        return false;
    }

    return true;
};

/** Download an upload with the bot token; the token goes only to the Slack host the event named. */
export const downloadSlackFile = async (botToken: string, attachment: InboundAttachment): Promise<DownloadedMedia> =>
    await fetchMedia(attachment.ref, { allowedHosts: SLACK_FILE_HOSTS, headers: { Authorization: `Bearer ${botToken}` } });

const slackApi = async <T extends { error?: string; ok?: boolean }>(botToken: string, method: string, body: BodyInit, contentType?: string): Promise<T> => {
    const response = await fetchOk(`https://slack.com/api/${method}`, {
        body,
        errorPrefix: `Slack ${method} failed`,
        headers: { Authorization: `Bearer ${botToken}`, ...(contentType && { "Content-Type": contentType }) },
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as T;

    if (!result.ok) {
        throw new Error(`Slack ${method} failed: ${result.error ?? "unknown error"}`);
    }

    return result;
};

/**
 * Upload a file into the channel (and thread) — Slack's external upload flow:
 * reserve an upload URL, send the bytes there, then complete it into the
 * conversation. Needs the `files:write` scope.
 */
export const sendSlackMedia = async (botToken: string, channelId: string, file: OutboundFile, threadTs?: string): Promise<MediaSendResult> => {
    const reserved = await slackApi<{ error?: string; file_id?: string; ok?: boolean; upload_url?: string }>(
        botToken,
        "files.getUploadURLExternal",
        new URLSearchParams({ filename: file.name, length: String(file.bytes.byteLength) }),
        "application/x-www-form-urlencoded",
    );

    if (!reserved.upload_url || !reserved.file_id || !isAllowedHost(new URL(reserved.upload_url).hostname, SLACK_FILE_HOSTS)) {
        throw new Error("Slack files.getUploadURLExternal returned no usable upload URL");
    }

    const form = new FormData();

    form.set("file", toBlob(file), file.name);

    const uploaded = await fetchOk(reserved.upload_url, {
        body: form,
        errorPrefix: "Slack file upload failed",
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_LONG_MS,
    });

    await uploaded.body?.cancel();

    await slackApi(
        botToken,
        "files.completeUploadExternal",
        JSON.stringify({ channel_id: channelId, files: [{ id: reserved.file_id, title: file.name }], ...(threadTs && { thread_ts: threadTs }) }),
        "application/json; charset=utf-8",
    );

    return "sent";
};
