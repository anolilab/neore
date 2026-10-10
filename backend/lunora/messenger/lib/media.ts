/**
 * Media in messenger chats — the rules every platform adapter shares.
 *
 * Inbound, a webhook only RECORDS what was attached (`InboundAttachment`: the
 * platform's own handle for it). Nothing is downloaded there: WeChat wants an
 * answer within 5s and LINE's reply token lives about a minute, so the bytes
 * are fetched by the scheduled reply action (`messenger/media.ts`), with the
 * owner's bot token, and only after the sender passed pairing and rate limits.
 *
 * Every download goes through {@link fetchMedia}: https only, the platform's
 * own hosts only (a bot token must never leave for a URL a payload named), a
 * deadline, {@link MESSENGER_MEDIA_MAX_BYTES} enforced before and while
 * reading, and every body it does not return cancelled. What is kept is decided
 * by {@link resolveMediaType}'s allowlist — never by the platform's say-so alone.
 */
import { FETCH_TIMEOUT_LONG_MS, fetchWithDeadline } from "../../lib/fetch-timeout";

/** Largest file taken in or sent out. Telegram's Bot API cannot serve more than this anyway. */
export const MESSENGER_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

/** Attachments handled per message; the rest are reported as skipped. */
export const MESSENGER_MAX_ATTACHMENTS = 5;

/**
 * Recordings transcribed per message, and the largest one transcribed. Each
 * transcription is a paid model call on the platform's key, started by a
 * third party writing to the owner's bot; it is also charged to the owner's
 * daily audio quota (`messenger/media.ts`). Past either cap the recording is
 * kept, just not transcribed.
 */
export const MESSENGER_MAX_TRANSCRIPTIONS = 2;
export const MESSENGER_TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;

/** Files sent back per reply. */
export const MESSENGER_MAX_OUTBOUND_FILES = 5;

/** How long a download link sent in place of a file stays valid. */
export const MESSENGER_LINK_TTL_SECONDS = 24 * 60 * 60;

/** What a sender attached — decides transcription and how the model sees it. */
export type AttachmentKind = "audio" | "file" | "image" | "video" | "voice";

/**
 * One attachment as the webhook saw it. `ref` is the platform's handle, never
 * bytes: Telegram `file_id`, Slack `url_private_download`, Discord CDN URL,
 * WhatsApp media id, LINE message id, Feishu `file_key`/`image_key`, Teams
 * `contentUrl`/`downloadUrl`, WeChat `MediaId`.
 */
export interface InboundAttachment {
    kind: AttachmentKind;
    /** Feishu: the message the resource belongs to. */
    messageId?: string;
    /** As the platform declared it; checked against the allowlist, not trusted. */
    mimeType?: string;
    name?: string;
    ref: string;
    /** Declared size in bytes, when the platform says; lets an oversized file be skipped unfetched. */
    size?: number;
    /** WeChat voice: the platform's own speech recognition, when the account has it on. */
    transcript?: string;
}

/**
 * Types kept, by MIME type. No HTML, SVG, scripts or archives: these files are
 * served back through signed URLs and shown in the app. Video is left out —
 * no model the reply runs on reads it.
 */
const IMAGE_TYPES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const;
const DOCUMENT_TYPES = [
    "application/json",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "text/markdown",
    "text/plain",
] as const;
const AUDIO_TYPES = ["audio/aac", "audio/amr", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/webm"] as const;

export const MESSENGER_MEDIA_TYPES: ReadonlySet<string> = new Set<string>([...IMAGE_TYPES, ...DOCUMENT_TYPES, ...AUDIO_TYPES]);

/** Spellings platforms use for the types above. */
const MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
    "application/ogg": "audio/ogg",
    "audio/m4a": "audio/mp4",
    "audio/mp3": "audio/mpeg",
    "audio/vnd.wave": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
    "audio/x-wav": "audio/wav",
    "image/jpg": "image/jpeg",
    "text/x-markdown": "text/markdown",
};

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
    aac: "audio/aac",
    amr: "audio/amr",
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    m4a: "audio/mp4",
    md: "text/markdown",
    mp3: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    wav: "audio/wav",
    webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The usual extension where a type has several. */
const PREFERRED_EXTENSIONS: Readonly<Record<string, string>> = { "audio/ogg": "ogg", "image/jpeg": "jpg" };

/** Types a model reads straight from the file (image and PDF parts); everything else reaches it as text. */
export const MODEL_READABLE_TYPES: ReadonlySet<string> = new Set<string>([...IMAGE_TYPES, "application/pdf"]);

/** Documents whose bytes ARE their text, inlined into the prompt. */
export const TEXT_DOCUMENT_TYPES: ReadonlySet<string> = new Set(["application/json", "text/csv", "text/markdown", "text/plain"]);

const normalize = (value: string | null | undefined): string => {
    const bare = (value ?? "").split(";", 1)[0]!.trim().toLowerCase();

    return MEDIA_TYPE_ALIASES[bare] ?? bare;
};

const extensionOf = (name: string | undefined): string => {
    const dot = name?.lastIndexOf(".") ?? -1;

    return name && dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * The type to store the file under, or `null` when it is not one we keep.
 * The first allowlisted candidate wins: the platform's declared type, then the
 * download's `Content-Type`, then the file name's extension (for the generic
 * `application/octet-stream` many CDNs answer with).
 */
export const resolveMediaType = (candidates: { declared?: string; name?: string; response?: string | null }): string | null => {
    for (const candidate of [normalize(candidates.declared), normalize(candidates.response), EXTENSION_TYPES[extensionOf(candidates.name)] ?? ""]) {
        if (MESSENGER_MEDIA_TYPES.has(candidate)) {
            return candidate;
        }
    }

    return null;
};

/** A file name for a download that came without one. */
export const defaultAttachmentName = (kind: AttachmentKind, mediaType: string): string => {
    const extension = PREFERRED_EXTENSIONS[mediaType] ?? Object.entries(EXTENSION_TYPES).find(([, type]) => type === mediaType)?.[0] ?? "bin";

    return `${kind === "voice" ? "voice-message" : kind}.${extension}`;
};

/** Host rules: an exact name, or `.suffix` for the name and every subdomain of it. */
export const isAllowedHost = (hostname: string, hosts: ReadonlyArray<string>): boolean => {
    const host = hostname.toLowerCase();

    return hosts.some((allowed) => (allowed.startsWith(".") ? host === allowed.slice(1) || host.endsWith(allowed) : host === allowed));
};

/** Bytes backed by a plain `ArrayBuffer`, as `Blob` and `FormData` take them. */
export type MediaBytes = Uint8Array<ArrayBuffer>;

export interface DownloadedMedia {
    bytes: MediaBytes;
    contentType: string | null;
}

export class MediaDownloadError extends Error {
    public readonly reason: "failed" | "too-large" | "unsupported-type";

    public constructor(reason: "failed" | "too-large" | "unsupported-type", message: string) {
        super(message);
        this.name = "MediaDownloadError";
        this.reason = reason;
    }
}

/**
 * Read a body, refusing it once it passes `maxBytes` — by `Content-Length`
 * before reading, and by count while reading, since the header can lie or be absent.
 */
export const readCappedBody = async (response: Response, maxBytes: number = MESSENGER_MEDIA_MAX_BYTES): Promise<MediaBytes> => {
    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();

        throw new MediaDownloadError("too-large", `File is ${String(declared)} bytes (max ${String(maxBytes)})`);
    }

    if (!response.body) {
        return new Uint8Array(0);
    }

    const reader = response.body.getReader();
    // With a declared length, the bytes go straight into one buffer: collecting
    // chunks and joining them held a 20 MB file twice at the peak. A body that
    // outgrows its header (it lied) falls back to chunks from there on.
    const preallocated = Number.isFinite(declared) && declared > 0 ? new Uint8Array(declared) : undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        if (total + value.byteLength > maxBytes) {
            await reader.cancel();

            throw new MediaDownloadError("too-large", `File is over ${String(maxBytes)} bytes`);
        }

        if (preallocated && chunks.length === 0 && total + value.byteLength <= preallocated.byteLength) {
            preallocated.set(value, total);
        } else {
            if (preallocated && chunks.length === 0 && total > 0) {
                chunks.push(preallocated.subarray(0, total));
            }

            chunks.push(value);
        }

        total += value.byteLength;
    }

    if (preallocated && chunks.length === 0) {
        return total === preallocated.byteLength ? preallocated : preallocated.subarray(0, total);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
};

export interface FetchMediaOptions {
    /** Hosts the URL — and any redirect — may point at (see {@link isAllowedHost}). */
    allowedHosts: ReadonlyArray<string>;
    /** Sent to the first host only; a redirect elsewhere goes without it. */
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
}

const MAX_REDIRECTS = 2;

const assertAllowedUrl = (raw: string | URL, allowedHosts: ReadonlyArray<string>): URL => {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        throw new MediaDownloadError("failed", "Invalid media URL");
    }

    const hasUserInfo = url.username !== "" || url.password !== ""; // secret-scanner:allow

    if (url.protocol !== "https:" || hasUserInfo || !isAllowedHost(url.hostname, allowedHosts)) {
        throw new MediaDownloadError("failed", `Refusing to fetch media from ${url.hostname}`);
    }

    return url;
};

/**
 * Download a platform file. Redirects are followed by hand (at most
 * {@link MAX_REDIRECTS}), each to an allowed host, and the credentials in
 * `headers` never follow one to a different host.
 */
export const fetchMedia = async (raw: string | URL, options: FetchMediaOptions): Promise<DownloadedMedia> => {
    let url = assertAllowedUrl(raw, options.allowedHosts);
    const firstHost = url.host;

    for (let hop = 0; ; hop += 1) {
        const response = await fetchWithDeadline(url, {
            headers: url.host === firstHost ? options.headers : undefined,
            redirect: "manual",
            timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_LONG_MS,
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");

            await response.body?.cancel();

            if (!location || hop >= MAX_REDIRECTS) {
                throw new MediaDownloadError("failed", "Media download redirected too often");
            }

            url = assertAllowedUrl(new URL(location, url), options.allowedHosts);

            continue;
        }

        if (!response.ok) {
            await response.body?.cancel();

            throw new MediaDownloadError("failed", `Media download failed: ${String(response.status)}`);
        }

        const contentType = response.headers.get("content-type");

        // Slack answers a bad token with its sign-in page, 200 and all.
        if (normalize(contentType) === "text/html") {
            await response.body?.cancel();

            throw new MediaDownloadError("failed", "Media download returned a web page");
        }

        return { bytes: await readCappedBody(response, options.maxBytes), contentType };
    }
};

/** A file on its way out: bytes for a platform upload, a signed URL for platforms that fetch by link. */
export interface OutboundFile {
    bytes: MediaBytes;
    mediaType: string;
    name: string;
    /** Short-lived signed GET URL for the same bytes. */
    url: string;
}

/** What a platform did with an outbound file; `"unsupported"` means send a link instead. */
export type MediaSendResult = "sent" | "unsupported" | "window_closed";

/** The text sent in place of a file a platform cannot take. */
export const fileLinkText = (file: Pick<OutboundFile, "name" | "url">): string => `${file.name}: ${file.url}`;

/** `bytes` as a multipart form part. */
export const toBlob = (file: Pick<OutboundFile, "bytes" | "mediaType">): Blob => new Blob([file.bytes], { type: file.mediaType });
