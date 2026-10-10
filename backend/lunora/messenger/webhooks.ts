/**
 * Webhook handlers for every messenger platform: Telegram, Slack, Discord,
 * WhatsApp, LINE, Feishu/Lark, Microsoft Teams and WeChat.
 *
 * Each handler does only what is platform-specific — its handshake, signature
 * check and payload parsing (in `platforms/<name>.ts`) — and hands every parsed
 * message to {@link acceptInbound}, which applies the rules all platforms share.
 * Attachments are only recorded here (their platform handles); the reply action
 * downloads them (`messenger/media.ts`), because WeChat allows 5s for an answer
 * and a LINE reply token lives about a minute.
 *
 * 1. **Freshness** — a message older than the platform's replay window is dropped.
 * 2. **Dedupe** — the event id is claimed once (`lib/claim-once.ts`, scope
 *    `messenger`), so a redelivery or a replayed request inside the window is
 *    answered 200 and otherwise ignored.
 * 3. **Pairing** — only the contact who paired with `/pair <code>` is answered
 *    (`messenger/pairing.ts`). A valid signature only proves the platform sent the
 *    request, not that the sender may spend the owner's key.
 * 4. **Rate limits** — per connection and per sender, on the owner's tier.
 *
 * Unknown connections and bad signatures get the same 401, so the response code
 * is no oracle for which connection ids exist. Rejections AFTER authentication
 * (stale, duplicate, rate-limited, foreign sender) answer 200: these platforms
 * retry non-2xx for hours or days and some disable endpoints that keep failing,
 * while the dedupe claim already makes a retry pointless.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { MESSENGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { SIGNED_REQUEST_WINDOW_MS } from "../lib/crypto";
import { httpScheduler } from "../lib/http-scheduler";
import { checkRateLimit } from "../lib/rate-limiter";
import { checkSenderPairing } from "./pairing";
import type { InboundMessage } from "./lib/types";
import { isFreshInbound, UNSUPPORTED_CONTENT_NOTICE } from "./lib/types";
import { discordSignedAt, parseDiscordEvent, validateDiscordSignature } from "./platforms/discord";
import { decryptFeishuPayload, parseFeishuEnvelope, validateFeishuSignature } from "./platforms/feishu";
import { LINE_EVENT_MAX_AGE_MS, parseLineWebhook, validateLineSignature } from "./platforms/line";
import type { TeamsActivity } from "./platforms/teams";
import { isTrustedServiceUrl, parseTeamsActivity, TEAMS_ACTIVITY_MAX_AGE_MS, verifyTeamsRequest } from "./platforms/teams";
import { parseSlackEvent, SLACK_EVENT_MAX_AGE_MS, validateSlackSignature } from "./platforms/slack";
import { parseTelegramUpdate, shouldValidateTelegramWebhook, TELEGRAM_UPDATE_MAX_AGE_MS } from "./platforms/telegram";
import { decryptWeChatMessage, parseWeChatMessage, readXmlField, validateWeChatSignature } from "./platforms/wechat";
import { parseWhatsAppWebhook, validateWhatsAppSignature, verifyWhatsAppSubscription, WHATSAPP_SERVICE_WINDOW_MS } from "./platforms/whatsapp";
import type { MessengerPlatform } from "./schema";

/** Feishu retries a failed push after 15s, 5m, 1h and 6h. */
const FEISHU_MESSAGE_MAX_AGE_MS = 7 * 60 * 60 * 1000;
/** WeChat retries three times within about 15 seconds. */
const WECHAT_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000;

const unauthorized = (): Response => Response.json({ error: "Unauthorized" }, { status: 401 });

const readJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

interface AcceptOptions {
    delivery?: { platformThreadTs?: string; replyToId?: string; replyToken?: string; serviceUrl?: string };
    /** The owner-side thread this chat maps to; defaults to `<platform>:<chatId>`. */
    externalThreadId?: string;
    maxAgeMs: number;
    platform: MessengerPlatform;
}

/**
 * Look up an active connection of `platform` and decrypt the owner's messenger
 * keys. `null` when the connection is unknown, inactive, of another platform,
 * or missing any required key — callers answer all of these with the same 401.
 */
export const resolveConnectionAndKeys = async <Key extends string>(
    context: HttpActionCtx,
    connectionId: string,
    platform: MessengerPlatform,
    requiredKeys: ReadonlyArray<Key>,
): Promise<{
    connection: Doc<"messengerConnections">;
    // `Record<Key, string>`: the loop below returns null unless every required
    // key is present, so a signature check is never handed an undefined secret.
    keys: Record<Key, string>;
} | null> => {
    if (!connectionId) {
        return null;
    }

    const connection = await context.runQuery(internal.messenger.functions.getConnectionById, {
        connectionId: connectionId as Id<"messengerConnections">,
    });

    if (!connection || connection.status !== "active" || connection.platform !== platform) {
        return null;
    }

    const keys = await context.runQuery(internal.auth.functions.getDecryptedMessengerKeysQuery, { userId: connection.userId });

    for (const key of requiredKeys) {
        if (!Object.hasOwn(keys, key)) {
            return null;
        }
    }

    return { connection, keys: keys as Record<Key, string> };
};

/**
 * Run a parsed message through the shared rules and, if it passes, persist it
 * and schedule the reply. Returns what happened, for logs and tests.
 */
export const acceptInbound = async (
    context: HttpActionCtx,
    connection: Doc<"messengerConnections">,
    message: InboundMessage,
    { delivery, externalThreadId, maxAgeMs, platform }: AcceptOptions,
): Promise<"accepted" | "duplicate" | "just_paired" | "rate_limited" | "stale" | "unpaired"> => {
    if (!isFreshInbound(message, maxAgeMs)) {
        return "stale";
    }

    const claimed = await context.runMutation(internal.lib.claim_once.claimKey, {
        key: `${connection._id}:${message.eventId}`,
        scope: "messenger",
        ttlMs: MESSENGER_CLAIM_TTL_MS,
        userId: connection.userId,
    });

    if (!claimed) {
        return "duplicate";
    }

    // After the dedupe claim, so a redelivered `/pair` or stranger message is not
    // answered twice.
    const pairing = await checkSenderPairing(
        context,
        connection,
        {
            chatId: message.chatId,
            displayName: message.senderName,
            senderId: message.senderId,
            text: message.kind === "text" ? message.text : undefined,
            username: message.senderUsername,
        },
        { ...delivery, inboundAt: message.timestampMs, platform, platformChatId: message.chatId },
    );

    if (pairing !== "proceed") {
        return pairing === "just_paired" ? "just_paired" : "unpaired";
    }

    const tier = await context.runQuery(internal.messenger.functions.getOwnerRateLimitTier, { userId: connection.userId });
    const perConnection = await checkRateLimit(context, `messenger/connection:${tier}`, { key: connection._id, throws: false });
    const perSender = perConnection.ok
        ? await checkRateLimit(context, `messenger/inbound:${tier}`, { key: `${connection._id}:${message.senderId}`, throws: false })
        : perConnection;

    if (!perSender.ok) {
        return "rate_limited";
    }

    const { threadId } = await context.runMutation(internal.messenger.functions.findOrCreateMessengerThread, {
        externalThreadId: externalThreadId ?? `${platform}:${message.chatId}`,
        messengerConnectionId: connection._id,
        source: platform,
        userId: connection.userId,
    });

    // Every message takes its row — and so its place in the thread — here, in
    // arrival order. A media message's attachments are downloaded and stored
    // by the reply action (work that does not fit in a webhook's answer time),
    // so its row is saved `pending` with the caption and completed there.
    const hasMedia = message.kind === "media" && (message.attachments?.length ?? 0) > 0;
    let messageId: Id<"messages"> | undefined;

    if (hasMedia || (message.kind === "text" && message.text)) {
        ({ messageId } = await context.runMutation(internal.messenger.functions.saveMessengerMessage, {
            ...(hasMedia && { pending: true }),
            text: message.text ?? "",
            threadId,
            userId: connection.userId,
        }));
    }

    await context.runMutation(internal.messenger.functions.touchConnection, { connectionId: connection._id });

    const media = hasMedia ? { attachments: message.attachments, caption: message.text } : {};

    await httpScheduler(context).runAfter(0, internal.messenger.respond.generateAndSendResponse, {
        ...media,
        inboundAt: message.timestampMs,
        messageId,
        notice: message.kind === "unsupported" ? UNSUPPORTED_CONTENT_NOTICE : undefined,
        platform,
        platformChatId: message.chatId,
        platformThreadTs: delivery?.platformThreadTs,
        replyToId: delivery?.replyToId,
        replyToken: delivery?.replyToken,
        serviceUrl: delivery?.serviceUrl,
        threadId,
        userId: connection.userId,
    });

    return "accepted";
};

const logOutcome = (platform: MessengerPlatform, outcome: Awaited<ReturnType<typeof acceptInbound>>): void => {
    if (outcome !== "accepted" && outcome !== "just_paired") {
        console.warn(`[Messenger] ${platform} message not processed: ${outcome}`);
    }
};

// ============================================================================
// Telegram
// ============================================================================

export const handleTelegramWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const resolved = await resolveConnectionAndKeys(context, connectionId, "telegram", ["telegram_bot_token", "telegram_webhook_secret"]);

    if (!resolved || !shouldValidateTelegramWebhook(request, resolved.keys.telegram_webhook_secret)) {
        return unauthorized();
    }

    // Bot and service messages parse to null and are acknowledged silently.
    const message = parseTelegramUpdate(readJson(await request.text()));

    if (message) {
        logOutcome("telegram", await acceptInbound(context, resolved.connection, message, { maxAgeMs: TELEGRAM_UPDATE_MAX_AGE_MS, platform: "telegram" }));
    }

    return Response.json({ ok: true });
};

// ============================================================================
// Slack (Events API)
// ============================================================================

export const handleSlackWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "slack", ["slack_bot_token", "slack_signing_secret"]);

    // The signature is checked BEFORE any branching, url_verification included:
    // otherwise an unauthenticated caller could have the challenge echoed back,
    // which is both a bypass and a connection-existence oracle.
    if (!resolved || !(await validateSlackSignature(request, rawBody, resolved.keys.slack_signing_secret))) {
        return unauthorized();
    }

    const parsed = parseSlackEvent(readJson(rawBody));

    if (parsed && "challenge" in parsed) {
        return Response.json({ challenge: parsed.challenge });
    }

    if (parsed) {
        const { message } = parsed;

        logOutcome(
            "slack",
            await acceptInbound(context, resolved.connection, message, {
                delivery: { platformThreadTs: message.threadTs },
                externalThreadId: `slack:${message.chatId}:${message.threadTs}`,
                maxAgeMs: SLACK_EVENT_MAX_AGE_MS,
                platform: "slack",
            }),
        );
    }

    return Response.json({ ok: true });
};

// ============================================================================
// Discord (Interactions)
// ============================================================================

export const handleDiscordWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "discord", ["discord_bot_token", "discord_public_key"]);

    // Discord requires the signature check on every request, PING included.
    if (!resolved || !(await validateDiscordSignature(request, rawBody, resolved.keys.discord_public_key))) {
        return unauthorized();
    }

    const parsed = parseDiscordEvent(readJson(rawBody), discordSignedAt(request));

    if (parsed && "pong" in parsed) {
        return Response.json({ type: 1 });
    }

    if (parsed) {
        // The request's own signature window is the replay window.
        logOutcome("discord", await acceptInbound(context, resolved.connection, parsed.message, { maxAgeMs: SIGNED_REQUEST_WINDOW_MS, platform: "discord" }));
    }

    return Response.json({ ok: true });
};

// ============================================================================
// WhatsApp (Meta Cloud API)
// ============================================================================

/** GET — Meta's subscription handshake. */
export const handleWhatsAppVerification = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const resolved = await resolveConnectionAndKeys(context, connectionId, "whatsapp", ["whatsapp_verify_token"]);
    const challenge = resolved ? verifyWhatsAppSubscription(new URL(request.url), resolved.keys.whatsapp_verify_token) : null;

    if (challenge === null) {
        return new Response("Forbidden", { status: 403 });
    }

    return new Response(challenge, { headers: { "Content-Type": "text/plain" }, status: 200 });
};

export const handleWhatsAppWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "whatsapp", [
        "whatsapp_access_token",
        "whatsapp_app_secret",
        "whatsapp_phone_number_id",
    ]);

    if (!resolved || !(await validateWhatsAppSignature(request.headers.get("x-hub-signature-256"), rawBody, resolved.keys.whatsapp_app_secret))) {
        return unauthorized();
    }

    const messages = parseWhatsAppWebhook(readJson(rawBody), resolved.keys.whatsapp_phone_number_id);

    for (const message of messages) {
        // The replay window IS the 24h service window: an older message could not be answered anyway.
        logOutcome("whatsapp", await acceptInbound(context, resolved.connection, message, { maxAgeMs: WHATSAPP_SERVICE_WINDOW_MS, platform: "whatsapp" }));
    }

    return Response.json({ ok: true });
};

// ============================================================================
// LINE
// ============================================================================

export const handleLineWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "line", ["line_channel_access_token", "line_channel_secret"]);

    if (!resolved || !(await validateLineSignature(request.headers.get("x-line-signature"), rawBody, resolved.keys.line_channel_secret))) {
        return unauthorized();
    }

    // The console's "Verify" posts an empty batch; it falls through to the 200.
    const messages = parseLineWebhook(readJson(rawBody));

    for (const message of messages) {
        logOutcome(
            "line",
            await acceptInbound(context, resolved.connection, message, {
                delivery: { replyToken: message.replyToken },
                maxAgeMs: LINE_EVENT_MAX_AGE_MS,
                platform: "line",
            }),
        );
    }

    return Response.json({ ok: true });
};

// ============================================================================
// Feishu / Lark
// ============================================================================

export const handleFeishuWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "feishu", [
        "feishu_app_id",
        "feishu_app_secret",
        "feishu_encrypt_key",
        "feishu_verification_token",
    ]);

    if (!resolved) {
        return unauthorized();
    }

    const { connection, keys } = resolved;
    const encrypted = (readJson(rawBody) as { encrypt?: unknown } | null)?.encrypt;

    // Unencrypted bodies are unsigned; we accept none.
    if (typeof encrypted !== "string") {
        return unauthorized();
    }

    let decrypted: unknown;

    try {
        decrypted = await decryptFeishuPayload(encrypted, keys.feishu_encrypt_key);
    } catch {
        return unauthorized();
    }

    const parsed = parseFeishuEnvelope(decrypted, keys.feishu_verification_token);

    if (!parsed) {
        return unauthorized();
    }

    // The challenge is the one request Feishu does not sign; decryption plus the token match stand in for it.
    if (parsed.kind === "challenge") {
        return Response.json({ challenge: parsed.challenge });
    }

    if (!(await validateFeishuSignature(request.headers, rawBody, keys.feishu_encrypt_key))) {
        return unauthorized();
    }

    if (parsed.kind === "message") {
        logOutcome("feishu", await acceptInbound(context, connection, parsed.message, { maxAgeMs: FEISHU_MESSAGE_MAX_AGE_MS, platform: "feishu" }));
    }

    return Response.json({ ok: true });
};

// ============================================================================
// Microsoft Teams (Bot Framework)
// ============================================================================

export const handleTeamsWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const activity = readJson(await request.text()) as TeamsActivity | null;
    const resolved = await resolveConnectionAndKeys(context, connectionId, "teams", ["teams_app_id", "teams_app_password"]);

    if (
        !resolved ||
        !activity ||
        !isTrustedServiceUrl(activity.serviceUrl) ||
        !(await verifyTeamsRequest(request.headers.get("authorization"), activity, resolved.keys.teams_app_id))
    ) {
        return unauthorized();
    }

    const message = parseTeamsActivity(activity);

    if (message) {
        logOutcome(
            "teams",
            await acceptInbound(context, resolved.connection, message, {
                delivery: { replyToId: message.activityId, serviceUrl: message.serviceUrl },
                maxAgeMs: TEAMS_ACTIVITY_MAX_AGE_MS,
                platform: "teams",
            }),
        );
    }

    return Response.json({});
};

// ============================================================================
// WeChat Official Account (beta)
// ============================================================================

/** GET — WeChat's server-configuration handshake. */
export const handleWeChatVerification = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const url = new URL(request.url);
    const resolved = await resolveConnectionAndKeys(context, connectionId, "wechat", ["wechat_token"]);
    const echostr = url.searchParams.get("echostr");
    const isValid =
        resolved !== null &&
        echostr !== null &&
        (await validateWeChatSignature(
            { nonce: url.searchParams.get("nonce"), signature: url.searchParams.get("signature"), timestamp: url.searchParams.get("timestamp") },
            resolved.keys.wechat_token,
        ));

    if (!isValid) {
        return new Response("Forbidden", { status: 403 });
    }

    return new Response(echostr, { headers: { "Content-Type": "text/plain" }, status: 200 });
};

export const handleWeChatWebhook = async (context: HttpActionCtx, request: Request, connectionId: string): Promise<Response> => {
    const url = new URL(request.url);
    const rawBody = await request.text();
    const resolved = await resolveConnectionAndKeys(context, connectionId, "wechat", [
        "wechat_app_id",
        "wechat_app_secret",
        "wechat_encoding_aes_key",
        "wechat_token",
    ]);
    const encrypted = readXmlField(rawBody, "Encrypt");

    // Safe mode only — see `platforms/wechat.ts` for why plaintext mode is refused.
    if (!resolved || url.searchParams.get("encrypt_type") !== "aes" || !encrypted) {
        return unauthorized();
    }

    const { connection, keys } = resolved;
    const isValid = await validateWeChatSignature(
        {
            encrypted,
            nonce: url.searchParams.get("nonce"),
            signature: url.searchParams.get("msg_signature"),
            timestamp: url.searchParams.get("timestamp"),
        },
        keys.wechat_token,
    );

    if (!isValid) {
        return unauthorized();
    }

    let xml: string;

    try {
        xml = await decryptWeChatMessage(encrypted, keys.wechat_encoding_aes_key, keys.wechat_app_id);
    } catch {
        return unauthorized();
    }

    const message = parseWeChatMessage(xml);

    if (message) {
        logOutcome("wechat", await acceptInbound(context, connection, message, { maxAgeMs: WECHAT_MESSAGE_MAX_AGE_MS, platform: "wechat" }));
    }

    // "success" tells WeChat not to retry and not to show the user an error.
    return new Response("success", { headers: { "Content-Type": "text/plain" }, status: 200 });
};
