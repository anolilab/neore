/**
 * The page source's fetch. Only through the SSRF-guarded `fetchWithTimeout`, which refuses a private or
 * unsafe address and does not follow redirects by itself: they are followed here, one hop at a time, so every
 * hop's target is checked again. The body is read to a byte cap and then cancelled.
 */
import { fetchWithTimeout, isSafeUrl } from "../../chat/tools/utilities";
import { assertOk } from "../../lib/fetch-timeout";
import { EventCheckError } from "./check-failure";
import type { FetchedPage } from "./types";

export const PAGE_MAX_BYTES = 1024 * 1024;
/** The whole request, body included. */
const PAGE_DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 3;
const TEXT_TYPE_RE = /^(?:text\/|application\/(?:xhtml\+xml|xml|json))/iu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const readCapped = async (response: Response): Promise<FetchedPage> => {
    const reader = response.body?.getReader();

    if (!reader) {
        return { text: "", truncated: false };
    }

    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            return { text: text + decoder.decode(), truncated: false };
        }

        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });

        if (bytes >= PAGE_MAX_BYTES) {
            await reader.cancel();

            return { text, truncated: true };
        }
    }
};

export const fetchWatchedPage = async (url: string): Promise<FetchedPage> => {
    let target = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (!isSafeUrl(target)) {
            throw new EventCheckError("That address cannot be watched: it is not a public http or https URL.");
        }

        const response = await fetchWithTimeout(
            target,
            {
                headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": "NeoreWatcher/1.0" },
                signal: AbortSignal.timeout(PAGE_DEADLINE_MS),
            },
            PAGE_DEADLINE_MS,
        );

        if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get("location");

            await response.body?.cancel();

            if (!location) {
                throw new EventCheckError("The page redirects without saying where.");
            }

            // `fetchWithTimeout` checks this target on the next turn.
            target = new URL(location, target).href;

            continue;
        }

        await assertOk(response, "The page could not be read");

        if (!TEXT_TYPE_RE.test(response.headers.get("content-type") ?? "text/html")) {
            await response.body?.cancel();

            throw new EventCheckError("The address is not a web page or text file.");
        }

        return await readCapped(response);
    }

    throw new EventCheckError("The page redirects too many times.");
};
