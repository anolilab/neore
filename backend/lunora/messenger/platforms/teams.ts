/**
 * Microsoft Teams adapter (Bot Framework / Azure Bot Service, REST).
 *
 * Inbound activities carry `Authorization: Bearer <JWT>` signed by the Bot
 * Connector. We check every requirement Microsoft lists for the Connector → bot
 * path: RS256 signature with a key from the OpenID metadata's JWKS (cached, and
 * refreshed at least daily — Microsoft's own requirement), `iss` =
 * `https://api.botframework.com`, `aud` = the bot's App ID, validity with 5
 * minutes of skew, the key's `endorsements` covering the activity's `channelId`,
 * and the `serviceUrl` claim equal to the activity's `serviceUrl`.
 *
 * Replies POST to `{serviceUrl}/v3/conversations/{id}/activities/{replyToId}`
 * with a client-credentials token from Entra ID. `serviceUrl` is the one value
 * in the request we send a bearer token TO, so on top of the signed claim it has
 * to be an https Bot Framework / Teams host — a token must never leave for a
 * host we would not otherwise talk to.
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages
 * @see https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference
 */
import type { JWK } from "jose";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import { FETCH_TIMEOUT_SHORT_MS, fetchOk } from "../../lib/fetch-timeout";
import type { DownloadedMedia, InboundAttachment, MediaSendResult, OutboundFile } from "../lib/media";
import { fetchMedia } from "../lib/media";
import type { InboundMessage } from "../lib/types";
import { inboundKind, splitMessage } from "../lib/types";

/** A file shared in a personal chat: a pre-authenticated SharePoint/OneDrive download link. */
const TEAMS_FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";
const TEAMS_FILE_HOSTS = [".sharepoint.com", ".sharepoint.us"];
/** The Connector's attachment endpoint may hand the bytes off to Skype's media store (without our token). */
const TEAMS_ATTACHMENT_REDIRECT_HOSTS = [".asm.skype.com"];
/** Images Teams renders inline from a URL in an attachment. */
const TEAMS_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/gif", "image/jpeg", "image/png"]);

const OPENID_METADATA_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** A token with an unknown `kid` forces a refetch, but at most this often — otherwise junk tokens would drive our outbound traffic. */
const JWKS_FORCED_REFRESH_MIN_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 5 * 60;
/** Bot Framework caps an activity at ~28 KB; leave headroom for the envelope. */
const TEAMS_TEXT_MAX = 20_000;

/** How old an activity may be and still be answered. */
export const TEAMS_ACTIVITY_MAX_AGE_MS = 60 * 60 * 1000;

export interface BotFrameworkJwk extends JWK {
    endorsements?: string[];
}

export type BotFrameworkKeyProvider = (forceRefresh: boolean) => Promise<BotFrameworkJwk[]>;

let jwksCache: { fetchedAt: number; keys: BotFrameworkJwk[] } | undefined;

/** The Bot Connector's signing keys, via its OpenID metadata document. */
export const fetchBotFrameworkKeys: BotFrameworkKeyProvider = async (forceRefresh) => {
    const now = Date.now();

    if (jwksCache && now - jwksCache.fetchedAt < (forceRefresh ? JWKS_FORCED_REFRESH_MIN_MS : JWKS_TTL_MS)) {
        return jwksCache.keys;
    }

    const metadataResponse = await fetchOk(OPENID_METADATA_URL, { errorPrefix: "Bot Framework OpenID metadata", timeoutMs: FETCH_TIMEOUT_SHORT_MS });
    const metadata = (await metadataResponse.json()) as {
        jwks_uri?: string;
    };
    const jwksUri = metadata.jwks_uri ? new URL(metadata.jwks_uri) : undefined;

    // The metadata document is fetched over TLS from a pinned URL, but its
    // `jwks_uri` is still data: refuse to take signing keys from anywhere else.
    if (jwksUri?.protocol !== "https:" || jwksUri.hostname !== "login.botframework.com") {
        throw new Error("Bot Framework OpenID metadata names an unexpected jwks_uri");
    }

    const jwksResponse = await fetchOk(jwksUri, { errorPrefix: "Bot Framework JWKS", timeoutMs: FETCH_TIMEOUT_SHORT_MS });
    const jwks = (await jwksResponse.json()) as {
        keys?: BotFrameworkJwk[];
    };

    jwksCache = { fetchedAt: now, keys: Array.isArray(jwks.keys) ? jwks.keys : [] };

    return jwksCache.keys;
};

const TRUSTED_SERVICE_HOSTS: ReadonlyArray<RegExp> = [
    /^smba\.trafficmanager\.net$/,
    /(?:^|\.)botframework\.com$/,
    /(?:^|\.)botframework\.us$/,
    /(?:^|\.)botframework\.azure\.us$/,
    /(?:^|\.)teams\.microsoft\.com$/,
    /(?:^|\.)teams\.microsoft\.us$/,
];

/** Whether `serviceUrl` is an https Bot Connector / Teams endpoint we may send a bot token to. */
export const isTrustedServiceUrl = (serviceUrl: string | undefined): boolean => {
    if (!serviceUrl) {
        return false;
    }

    try {
        const url = new URL(serviceUrl);

        return url.protocol === "https:" && !url.username && !url.password && TRUSTED_SERVICE_HOSTS.some((pattern) => pattern.test(url.hostname)); // secret-scanner:allow
    } catch {
        return false;
    }
};

/** `value` without its trailing slashes — a scan, not a `/\/+$/` replace, which backtracks on a long run of them. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

const normalizeServiceUrl = (value: unknown): string => (typeof value === "string" ? trimTrailingSlashes(value).toLowerCase() : "");

export interface TeamsActivity {
    attachments?: { content?: { downloadUrl?: string; fileType?: string }; contentType?: string; contentUrl?: string; name?: string }[];
    channelId?: string;
    conversation?: { id?: string; tenantId?: string };
    from?: { aadObjectId?: string; id?: string; name?: string };
    id?: string;
    serviceUrl?: string;
    text?: string;
    timestamp?: string;
    type?: string;
}

/**
 * Validate the Connector's bearer token for `activity`. Every failure — bad
 * header, unknown key, missing endorsement, wrong claims — is just `false`.
 */
export const verifyTeamsRequest = async (
    authorization: string | null,
    activity: TeamsActivity,
    appId: string,
    options: { getKeys?: BotFrameworkKeyProvider; now?: Date } = {},
): Promise<boolean> => {
    if (!authorization?.startsWith("Bearer ") || !activity.channelId || !activity.serviceUrl) {
        return false;
    }

    const getKeys = options.getKeys ?? fetchBotFrameworkKeys;

    const token = authorization.slice("Bearer ".length).trim();

    try {
        const { alg, kid } = decodeProtectedHeader(token);

        if (alg !== "RS256" || !kid) {
            return false;
        }

        const cachedKeys = await getKeys(false);
        let jwk = cachedKeys.find((candidate) => candidate.kid === kid);

        if (!jwk) {
            const refreshedKeys = await getKeys(true);

            jwk = refreshedKeys.find((candidate) => candidate.kid === kid);
        }

        if (!jwk) {
            return false;
        }

        // Endorsements bind a key to the channels it may speak for.
        if (Array.isArray(jwk.endorsements) && !jwk.endorsements.includes(activity.channelId)) {
            return false;
        }

        // The key minus our `endorsements` extension, which `importJWK` does not know.
        const publicJwk: JWK = Object.fromEntries(Object.entries(jwk).filter(([name]) => name !== "endorsements"));
        const key = await importJWK({ ...publicJwk, alg: "RS256" }, "RS256");
        const { payload } = await jwtVerify(token, key, {
            algorithms: ["RS256"],
            audience: appId,
            clockTolerance: CLOCK_SKEW_SECONDS,
            currentDate: options.now,
            issuer: BOT_FRAMEWORK_ISSUER,
        });

        return normalizeServiceUrl(payload.serviceUrl) !== "" && normalizeServiceUrl(payload.serviceUrl) === normalizeServiceUrl(activity.serviceUrl);
    } catch {
        return false;
    }
};

/**
 * Files and pasted images. A file arrives as a pre-authenticated download link;
 * an image as a Connector URL that needs the bot token — kept only when that
 * URL is a trusted Bot Framework host, since the token will be sent there. The
 * message's own HTML rendering and cards are not attachments to read.
 */
const teamsAttachments = (attachments: NonNullable<TeamsActivity["attachments"]>): InboundAttachment[] =>
    attachments.flatMap((attachment): InboundAttachment[] => {
        if (attachment.contentType === TEAMS_FILE_DOWNLOAD_INFO && attachment.content?.downloadUrl) {
            return [{ kind: "file", name: attachment.name, ref: attachment.content.downloadUrl }];
        }

        if (attachment.contentType?.startsWith("image/") && attachment.contentUrl && isTrustedServiceUrl(attachment.contentUrl)) {
            return [{ kind: "image", mimeType: attachment.contentType, name: attachment.name, ref: attachment.contentUrl }];
        }

        return [];
    });

export interface TeamsInboundMessage extends InboundMessage {
    activityId: string;
    serviceUrl: string;
}

/** A user message activity, or null for typing, conversationUpdate, invokes and the like. */
export const parseTeamsActivity = (activity: TeamsActivity): TeamsInboundMessage | null => {
    if (activity.type !== "message" || !activity.id || !activity.from?.id || !activity.conversation?.id || !activity.serviceUrl) {
        return null;
    }

    // Channel/group messages include the bot's own @-mention as `<at>Name</at>`.
    const text = (activity.text ?? "").replaceAll(/<at>[^<]*<\/at>/g, "").trim();
    const attachments = teamsAttachments(activity.attachments ?? []);

    return {
        ...(attachments.length > 0 && { attachments }),
        activityId: activity.id,
        chatId: activity.conversation.id,
        eventId: activity.id,
        kind: inboundKind(text, attachments),
        senderId: activity.from.aadObjectId ?? activity.from.id,
        senderName: activity.from.name,
        serviceUrl: activity.serviceUrl,
        text: text || undefined,
        timestampMs: activity.timestamp ? Date.parse(activity.timestamp) : NaN,
    };
};

const connectorTokenCache = new Map<string, { expiresAt: number; token: string }>();

/** Forget the cached connector token for an app (account deletion). */
export const forgetTeamsTokens = (appId: string): void => {
    for (const cacheKey of connectorTokenCache.keys()) {
        if (cacheKey.startsWith(`${appId}|`)) {
            connectorTokenCache.delete(cacheKey);
        }
    }
};

export interface TeamsCredentials {
    appId: string;
    appPassword: string;
    /** Single-tenant bots (the only kind Azure creates now) need their tenant; unset = multi-tenant `botframework.com`. */
    tenantId?: string;
}

const getConnectorToken = async ({ appId, appPassword, tenantId }: TeamsCredentials): Promise<string> => {
    const tenant = tenantId?.trim() || "botframework.com";
    const cacheKey = `${appId}|${tenant}`;
    const cached = connectorTokenCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.token;
    }

    const response = await fetchOk(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        body: new URLSearchParams({
            client_id: appId,
            client_secret: appPassword,
            grant_type: "client_credentials",
            scope: "https://api.botframework.com/.default",
        }),
        errorPrefix: "Bot Framework token request failed",
        method: "POST",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });
    const result = (await response.json()) as { access_token?: string; expires_in?: number };

    if (!result.access_token) {
        throw new Error("Bot Framework token response had no access_token");
    }

    connectorTokenCache.set(cacheKey, { expiresAt: Date.now() + Math.max(0, (result.expires_in ?? 0) - 300) * 1000, token: result.access_token });

    return result.access_token;
};

export const sendTeamsMessage = async (
    credentials: TeamsCredentials,
    serviceUrl: string,
    conversationId: string,
    replyToId: string,
    text: string,
): Promise<void> => {
    if (!isTrustedServiceUrl(serviceUrl)) {
        throw new Error("Refusing to send a Bot Framework token to an untrusted serviceUrl");
    }

    const token = await getConnectorToken(credentials);
    const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
    const url = new URL(`v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`, base);

    for (const chunk of splitMessage(text, TEAMS_TEXT_MAX)) {
        const response = await fetchOk(url, {
            body: JSON.stringify({ replyToId, text: chunk, textFormat: "markdown", type: "message" }),
            errorPrefix: "Teams reply failed",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
            redirect: "manual",
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        await response.body?.cancel();
    }
};

/**
 * Download a shared file or image. A SharePoint download link is
 * pre-authenticated and gets no token; a Connector attachment URL gets the bot
 * token, and only when it is a trusted Bot Framework host.
 */
export const downloadTeamsAttachment = async (credentials: TeamsCredentials, attachment: InboundAttachment): Promise<DownloadedMedia> => {
    if (attachment.kind === "file") {
        return await fetchMedia(attachment.ref, { allowedHosts: TEAMS_FILE_HOSTS });
    }

    if (!isTrustedServiceUrl(attachment.ref)) {
        throw new Error("Refusing to send a Bot Framework token to an untrusted attachment URL");
    }

    const token = await getConnectorToken(credentials);

    return await fetchMedia(attachment.ref, {
        allowedHosts: [new URL(attachment.ref).hostname, ...TEAMS_ATTACHMENT_REDIRECT_HOSTS],
        headers: { Authorization: `Bearer ${token}` },
    });
};

/**
 * Send an image as an inline attachment Teams fetches from the signed URL.
 * Other files need Teams' file-consent flow, so they are `"unsupported"` and go
 * as a link.
 */
export const sendTeamsMedia = async (
    credentials: TeamsCredentials,
    serviceUrl: string,
    conversationId: string,
    replyToId: string,
    file: OutboundFile,
): Promise<MediaSendResult> => {
    if (!TEAMS_IMAGE_TYPES.has(file.mediaType)) {
        return "unsupported";
    }

    if (!isTrustedServiceUrl(serviceUrl)) {
        throw new Error("Refusing to send a Bot Framework token to an untrusted serviceUrl");
    }

    const token = await getConnectorToken(credentials);
    const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
    const response = await fetchOk(new URL(`v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`, base), {
        body: JSON.stringify({ attachments: [{ contentType: file.mediaType, contentUrl: file.url, name: file.name }], replyToId, type: "message" }),
        errorPrefix: "Teams reply failed",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        method: "POST",
        redirect: "manual",
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });

    await response.body?.cancel();

    return "sent";
};
