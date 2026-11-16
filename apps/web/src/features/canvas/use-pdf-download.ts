import { useLingui } from "@lingui/react/macro";
import { chatAttachmentLimit } from "@neore/backend/document-limits";
import { isFetchableUrl } from "@neore/ui/hooks/use-fetchable-origins";
import { latestPdfUrl } from "@neore/ui/utils/pdf-preview-event";
import { useEffect, useRef, useState } from "react";

import { showError } from "@/lib/toast";

/** The most a chat PDF can weigh: the upload cap for its type. */
const MAX_DOWNLOAD_BYTES = chatAttachmentLimit("application/pdf").maxBytes;

/** How long a download may go without receiving any bytes before it is failed, as the viewer fails a stalled load. */
const DOWNLOAD_STALL_MS = 30_000;

/**
 * The response body as a blob, read chunk by chunk: each chunk restarts `restartDeadline`, so a body that stops arriving
 * is aborted by it rather than leaving the download pending.
 */
const readBody = async (response: Response, restartDeadline: () => void): Promise<Blob> => {
    if (!response.body) {
        return await response.blob();
    }

    const chunks: BlobPart[] = [];
    const reader = response.body.getReader();
    let received = 0;

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        received += chunk.value.byteLength;

        // A chat PDF is never larger than its upload cap; a body that keeps coming is not kept in memory.
        if (received > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();

            throw new Error("The PDF is larger than a chat attachment can be.");
        }

        chunks.push(new Uint8Array(chunk.value));
        restartDeadline();
    }

    return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/pdf" });
};

/**
 * The last saved download, one per tab: a new download releases it, so neither repeated clicks nor reopening the panel keeps
 * more than one PDF's bytes alive for the minute each would otherwise be held.
 */
const savedFile: { current: { release: () => void } | null } = { current: null };

/** How long a downloaded PDF's object URL stays valid: long enough for the browser to start the download. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/**
 * Saves a chat PDF the side panel shows. The link is cross-origin, and a browser opens a cross-origin PDF inline whatever the
 * `download` attribute says, so the file is fetched and saved from a local object URL instead. `failed` is true while the
 * last download of this file failed.
 */
const usePdfDownload = (file: { filename?: string; url: string }, origins: ReadonlyArray<string>): { download: () => Promise<void>; failed: boolean } => {
    const { t } = useLingui();
    // The file whose download failed: the notice belongs to that file, not to the next one shown.
    const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
    const downloadFailed = failedUrl === file.url;
    // A download belongs to the document it started for. Showing another document, or closing the panel, abandons it: its fetch is
    // aborted, and a late answer saves nothing, so the reader never gets a PDF they have left.
    const pendingDownload = useRef<AbortController | null>(null);

    useEffect(
        () => () => {
            pendingDownload.current?.abort();
            pendingDownload.current = null;
        },
        [file.url],
    );

    const download = async () => {
        const { filename } = file;
        // The message re-signs its attachment URL before the old one expires; the panel may have been open longer than that.
        const url = latestPdfUrl(file.url);

        if (!isFetchableUrl(url, origins)) {
            showError(t`The PDF could not be downloaded.`);

            return;
        }

        pendingDownload.current?.abort();

        const attempt = new AbortController();

        pendingDownload.current = attempt;

        let stalled = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const restartDeadline = () => {
            clearTimeout(deadline);
            deadline = setTimeout(() => {
                // Already left for another file or a closed panel: not a stall to report.
                if (attempt.signal.aborted) {
                    return;
                }

                stalled = true;
                attempt.abort();
            }, DOWNLOAD_STALL_MS);
        };

        restartDeadline();

        try {
            const response = await fetch(url, { signal: attempt.signal });

            if (!response.ok) {
                throw new Error("The PDF could not be fetched.");
            }

            const blob = await readBody(response, restartDeadline);

            if (attempt.signal.aborted) {
                return;
            }

            // One saved file is held at a time: a new download lets the previous one's bytes go, so repeated clicks on a
            // large PDF do not pile up copies for the minute each would otherwise be kept.
            savedFile.current?.release();

            const objectUrl = URL.createObjectURL(blob);
            const link = globalThis.document.createElement("a");

            link.href = objectUrl;
            link.download = filename ?? "document.pdf";
            // Attached while it is clicked: a detached link is ignored by some browsers. The URL outlives the click, so the
            // download can start before it is revoked.
            document.body.appendChild(link);
            link.click();
            link.remove();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const release = () => {
                globalThis.clearTimeout(timer);
                URL.revokeObjectURL(objectUrl);

                if (savedFile.current?.release === release) {
                    savedFile.current = null;
                }
            };

            timer = globalThis.setTimeout(release, DOWNLOAD_URL_LIFETIME_MS);
            savedFile.current = { release };
            setFailedUrl(undefined);
        } catch (error) {
            // Left for another file or a closed panel: nothing to report. A stalled download is a failure to report.
            if (attempt.signal.aborted && !stalled) {
                return;
            }

            console.error("Failed to download the PDF:", error);
            setFailedUrl(file.url);
            showError(t`The PDF could not be downloaded.`);
        } finally {
            clearTimeout(deadline);

            if (pendingDownload.current === attempt) {
                pendingDownload.current = null;
            }
        }
    };

    return { download, failed: downloadFailed };
};

export default usePdfDownload;
