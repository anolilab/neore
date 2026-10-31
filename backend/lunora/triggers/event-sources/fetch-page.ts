/**
 * The page source's fetch. Only through the SSRF-guarded `fetchWithTimeout`, which refuses a private or
 * unsafe address and does not follow redirects by itself: they are followed here, one hop at a time, so every
 * hop's target is checked again. The body is read to a byte cap and then cancelled.
 */
import { fetchWithTimeout, isSafeUrl } from "../../chat/tools/utilities";
import { assertOk } from "../../lib/fetch-timeout";
import { EventCheckError } from "./check-failure";
import type { FetchedPage } from "./types";

/**
 * A longer page is read to this cut and hashed as cut: a change past it is not seen (documented in `docs/triggers.mdx` and
 * on the form). The cap is what bounds a check's memory and time.
 */
export const PAGE_MAX_BYTES = 1024 * 1024;
/** The whole check — every redirect hop and the body — shares this one deadline. */
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

        // Cut at the budget before decoding: one chunk may be far larger than what is left.
        const chunk = value.byteLength > PAGE_MAX_BYTES - bytes ? value.subarray(0, PAGE_MAX_BYTES - bytes) : value;

        bytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });

        if (bytes >= PAGE_MAX_BYTES) {
            await reader.cancel();

            return { text, truncated: true };
        }
    }
};

/** Where a redirect leads. A `Location` that is no address is the owner's to fix, like a redirect that names none. */
const redirectTarget = (location: string, from: string): string => {
    try {
        return new URL(location, from).href;
    } catch (error) {
        throw new EventCheckError("The page redirects to an address that cannot be read.", { cause: error });
    }
};

export const fetchWatchedPage = async (url: string): Promise<FetchedPage> => {
    let target = url;
    const deadline = Date.now() + PAGE_DEADLINE_MS;
    // One signal for all hops, so the body read is bounded by what is left too.
    const signal = AbortSignal.timeout(PAGE_DEADLINE_MS);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (!isSafeUrl(target)) {
            throw new EventCheckError("That address cannot be watched: it is not a public http or https URL.");
        }

        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            throw new Error(`Request timeout after ${String(PAGE_DEADLINE_MS)}ms`);
        }

        const response = await fetchWithTimeout(
            target,
            { headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": "NeoreWatcher/1.0" }, signal },
            remaining,
        );

        if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get("location");

            await response.body?.cancel();

            if (!location) {
                throw new EventCheckError("The page redirects without saying where.");
            }

            // `fetchWithTimeout` checks this target on the next turn.
            target = redirectTarget(location, target);

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
