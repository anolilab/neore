/**
 * A frame a video node hands to the next clip. A `frame-start` or `frame-end` wire is cut from the
 * clip its source produced in this run by fal's frame extraction, then stored as a chat file the
 * run's owner can read. Nothing is captured in the browser and no earlier run's frame is reused.
 */
import { LunoraError, v } from "lunorash/server";

import { storeFile } from "../agent/client";
import { internalAction } from "../_generated/server";
import { FETCH_TIMEOUT_LONG_MS, fetchOk } from "../lib/fetch-timeout";
import { MAX_LENGTH } from "../lib/validators";
import type { FrameKind } from "./mentions";

export const FRAME_EXTRACT_ENDPOINT = "fal-ai/ffmpeg-api/extract-frame";

/** fal's name for each frame a wire can carry. */
const FAL_FRAME_TYPE: Record<FrameKind, "first" | "last"> = { end: "last", start: "first" };

const POLL_INTERVAL_MS = 1000;

/**
 * The whole poll window. Extraction takes seconds; a request still queued after this is abandoned
 * (fal bills it either way, so there is no point waiting on it inside a run).
 */
export const EXTRACT_DEADLINE_MS = 3 * 60 * 1000;

/** fal's queue host. The platform key is sent to the URLs fal returns, so only this host is followed. */
const FAL_QUEUE_HOST = "queue.fal.run";

interface FalExtractResult {
    images?: { content_type?: string; url?: string }[];
}

/**
 * A URL fal returned for polling or the result. It must be https on the queue host the submit used:
 * a response that names any other host would receive the platform key.
 */
const assertFalQueueUrl = (value: string | undefined, name: string): string => {
    let url: URL | undefined;

    try {
        url = new URL(value ?? "");
    } catch {
        url = undefined;
    }

    if (url?.protocol !== "https:" || url.hostname !== FAL_QUEUE_HOST) {
        throw new Error(`fal.ai returned a ${name} outside ${FAL_QUEUE_HOST}; the key is not sent to it`);
    }

    return url.href;
};

/**
 * One frame of a clip, from fal's queue. The request is submitted ONCE: a failed poll or download
 * throws rather than submitting again, because every submit is billed. A caller that retries the
 * whole run pays for the frame again, which is the price of a fresh run, not of this helper.
 */
export const extractFrameImage = async (videoUrl: string, frame: FrameKind, apiKey: string, pollIntervalMs = POLL_INTERVAL_MS): Promise<Blob> => {
    // Every request that carries the key refuses a redirect: a 3xx would otherwise be
    // followed to whatever host it names, with the `Authorization` header.
    const headers = { Authorization: `Key ${apiKey}` };
    const submit = await fetchOk(`https://${FAL_QUEUE_HOST}/${FRAME_EXTRACT_ENDPOINT}`, {
        body: JSON.stringify({ frame_type: FAL_FRAME_TYPE[frame], video_url: videoUrl }),
        errorPrefix: "fal.ai frame extraction failed",
        headers: { ...headers, "Content-Type": "application/json" },
        includeBody: true,
        method: "POST",
        redirect: "error",
    });
    const queued = (await submit.json()) as { response_url?: string; status_url?: string };

    if (!queued.status_url || !queued.response_url) {
        throw new Error("fal.ai returned no queue URLs for the frame");
    }

    // Checked before the first keyed request: a rejected URL has received nothing.
    const statusUrl = assertFalQueueUrl(queued.status_url, "status URL");
    const resultUrl = assertFalQueueUrl(queued.response_url, "result URL");
    const deadline = Date.now() + EXTRACT_DEADLINE_MS;

    while (Date.now() < deadline) {
        const statusResponse = await fetchOk(statusUrl, { errorPrefix: "fal.ai frame status failed", headers, redirect: "error" });
        const status = (await statusResponse.json()) as { error?: string; status?: string };

        if (status.status === "COMPLETED") {
            const resultResponse = await fetchOk(resultUrl, { errorPrefix: "fal.ai frame result failed", headers, redirect: "error" });
            const result = (await resultResponse.json()) as FalExtractResult;
            const image = result.images?.[0];

            if (!image?.url) {
                throw new Error("fal.ai returned no frame image");
            }

            const download = await fetchOk(image.url, { errorPrefix: "Frame download failed", timeoutMs: FETCH_TIMEOUT_LONG_MS });

            return new Blob([await download.arrayBuffer()], { type: image.content_type ?? "image/png" });
        }

        if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") {
            throw new Error(`fal.ai frame extraction failed: ${status.error ?? status.status ?? "unknown status"}`);
        }

        await new Promise((resolve) => {
            setTimeout(resolve, pollIntervalMs);
        });
    }

    throw new Error("fal.ai frame extraction timed out");
};

/** Extracts a frame of a clip and stores it for `userId`. Called by a video node that has a frame wire. */
export const extractVideoFrame = internalAction
    .input({
        frame: v.union(v.literal("start"), v.literal("end")),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
        videoUrl: v.string().max(MAX_LENGTH.url),
    })
    .output(v.object({ fileId: v.string(), mimeType: v.string() }))
    .action(async ({ args: { frame, threadId, userId, videoUrl }, ctx: context }) => {
        const falApiKey = process.env.FAL_API_KEY;

        if (!falApiKey) {
            throw new LunoraError("BAD_REQUEST", "FAL_API_KEY not configured");
        }

        const blob = await extractFrameImage(videoUrl, frame, falApiKey);
        const { file } = await storeFile(context, blob, { threadId, userId });

        return { fileId: file.fileId, mimeType: blob.type };
    });
