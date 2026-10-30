/**
 * Files a coding agent's reply shows (plans/acp-agent-host.md §4.8), from the folder to the backend, in the main
 * process: the page never holds the bytes.
 *
 * An agent has no tool to show an image, so it writes the file and refers to it with a Markdown image. At the end
 * of the turn each such reference is handed to the core, which resolves it against the approved folder alone and
 * opens it there (`..`, an absolute path elsewhere and a link out are refused without opening anything), sniffs
 * its type and takes its size from the open file. What comes back is uploaded over TUS to the device upload
 * route (`backend/lunora/acp/upload-http.ts`), each request signed in the core, and its upload id goes to the
 * backend as a `media` event. A refused reference produces nothing, so the reply shows it as text.
 *
 * Only an image reference (`![alt](path)`) is looked at, never a plain link: an agent links existing files all the
 * time, and a mention is not a request to upload one.
 */
/* eslint-disable no-await-in-loop -- one file at a time, in order: each is read whole, and a turn attaches a handful */
import { createHash, randomUUID } from "node:crypto";

import type { MediaEvent } from "./host-events";

/** Markdown images looked at in one turn; the backend takes eight files per turn. */
export const MAX_REFERENCES = 8;
/** What the backend accepts in one `PATCH` (`HOST_UPLOAD_MAX_CHUNK_BYTES`): TUS's usual chunk size. */
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

const TRAILING_SLASH = /\/$/u;
const REQUEST_TIMEOUT_MS = 60_000;
/** The upload route's headers (`HOST_UPLOAD_PAYLOAD_HEADER`, `HOST_UPLOAD_SIGNATURE_HEADER`). */
const PAYLOAD_HEADER = "neore-device-request";
const SIGNATURE_HEADER = "neore-device-signature";

/** `![alt](target "title")`; the target is `&lt;…>` or runs to the first space or `)`. */
// eslint-disable-next-line sonarjs/regex-complexity -- one Markdown shape; `reply.ts` on the backend reads the same
const IMAGE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu;

/** The targets of the Markdown images in `text`, each once, in order, at most {@link MAX_REFERENCES}. */
export const imageReferences = (text: string): string[] => {
    const found = new Set<string>();

    for (const match of text.matchAll(IMAGE)) {
        let target = match[1] ?? "";

        if (target.startsWith("<") && target.endsWith(">")) {
            target = target.slice(1, -1);
        }

        try {
            target = decodeURIComponent(target);
        } catch {
            // Not percent-encoded text: it is the path as written.
        }

        if (target !== "" && !target.startsWith("#")) {
            found.add(target);
        }

        if (found.size >= MAX_REFERENCES) {
            break;
        }
    }

    return [...found];
};

/** What `DeviceCore.acpReadMedia` answers (`packages/device-core-node`). */
export interface MediaRead {
    bytes?: Uint8Array;
    kind: string;
    mime: string;
    name: string;
    size: number;
    status: string;
}

export interface MediaOptions {
    /** This computer's paired device id; undefined while it is not paired. */
    deviceId: () => string | undefined;
    /** `&lt;backend origin>/hosts/uploads`. */
    endpoint: URL;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    now?: () => number;
    /** `DeviceCore.acpReadMedia`, for the session's agent and folder. */
    read: (agentKey: string, folderId: string, reference: string) => Promise<MediaRead>;
    /** `DeviceCore.signUpload`. */
    sign: (payload: string) => string;
}

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** What a `media` event may carry; the backend refuses a post with a field past these. */
const eventFor = (file: MediaRead, reference: string, uploadId?: string): MediaEvent => {
    return {
        contentType: file.mime.slice(0, 100),
        kind: "media",
        name: file.name.slice(0, 255),
        reference: reference.slice(0, 1024),
        size: file.size,
        ...uploadId !== undefined && { uploadId: uploadId.slice(0, 64) },
    };
};

/** One signed request to the upload route. */
const request = async (options: MediaOptions, deviceId: string, url: URL, init: RequestInit & { fields: Record<string, unknown>; headers: Record<string, string> }): Promise<Response> => {
    const payload = JSON.stringify({ deviceId, issuedAt: (options.now ?? Date.now)(), kind: "upload", v: 1, ...init.fields });

    return await (options.fetch ?? fetch)(url, {
        ...init.body !== undefined && { body: init.body },
        headers: { ...init.headers, [PAYLOAD_HEADER]: base64url(payload), [SIGNATURE_HEADER]: options.sign(payload), "Tus-Resumable": "1.0.0" },
        method: init.method,
        // A redirect would resend the signed body and headers to wherever it points.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
};

/** Uploads `file` over TUS and returns its upload id, or null when any request of it was refused or failed. */
export const uploadFile = async (options: MediaOptions, file: MediaRead & { bytes: Uint8Array }): Promise<string | null> => {
    const deviceId = options.deviceId();

    if (deviceId === undefined) {
        return null;
    }

    const metadata = `filename ${Buffer.from(file.name).toString("base64")},filetype ${Buffer.from(file.mime).toString("base64")}`;
    const created = await request(options, deviceId, options.endpoint, {
        fields: { method: "POST", nonce: randomUUID(), size: file.bytes.byteLength, type: file.mime },
        headers: { "Upload-Length": String(file.bytes.byteLength), "Upload-Metadata": metadata },
        method: "POST",
    });

    await created.body?.cancel();

    const location = created.headers.get("location");
    const uploadId = location !== null && created.status === 201 ? new URL(location, options.endpoint).pathname.split("/").pop() : undefined;

    if (uploadId === undefined || uploadId === "") {
        return null;
    }

    const target = new URL(`${options.endpoint.pathname.replace(TRAILING_SLASH, "")}/${uploadId}`, options.endpoint);

    for (let offset = 0; offset < file.bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
        const chunk = Buffer.from(file.bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
        const sent = await request(options, deviceId, target, {
            body: chunk,
            fields: { bodySha256: createHash("sha256").update(chunk).digest("hex"), method: "PATCH", offset, uploadId },
            headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
            method: "PATCH",
        });

        await sent.body?.cancel();

        if (sent.status !== 204) {
            return null;
        }
    }

    return uploadId;
};

/**
 * The `media` events for the references in a finished turn's text. A reference the core refuses (outside the
 * folder, not a file, not an allowed type) gives no event. A file over the cap is named with its size and not
 * uploaded; a file whose upload fails is dropped, because a name with nothing behind it would only mislead.
 */
export const collectMedia = async (options: MediaOptions, agentKey: string, folderId: string, text: string): Promise<MediaEvent[]> => {
    const events: MediaEvent[] = [];

    for (const reference of imageReferences(text)) {
        try {
            const file = await options.read(agentKey, folderId, reference);

            if (file.status === "too_large") {
                events.push(eventFor(file, reference));
            } else if (file.status === "read" && file.bytes !== undefined) {
                const uploadId = await uploadFile(options, { ...file, bytes: file.bytes });

                if (uploadId === null) {
                    options.log?.("[acp-host] a file the agent wrote could not be uploaded; the reply shows it as text");
                } else {
                    events.push(eventFor(file, reference, uploadId));
                }
            }
        } catch (error) {
            // Neither the path nor the name is logged: they are the agent's text.
            options.log?.(`[acp-host] a file the agent wrote could not be read: ${(error as Error).name}`);
        }
    }

    return events;
};
