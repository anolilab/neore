import { createContext, use } from "react";

/** Origins a preview may fetch besides its own page's: the app passes its backend's, which serves signed storage URLs. */
const NO_ORIGINS: ReadonlyArray<string> = [];

export const FetchableOriginsContext = createContext<ReadonlyArray<string>>(NO_ORIGINS);

export const useFetchableOrigins = (): ReadonlyArray<string> => use(FetchableOriginsContext);

/**
 * Whether a preview may read `url`: a `data:` or `blob:` URL, or an http(s) one
 * on the page's own origin or one of `allowedOrigins` (exact origins, e.g.
 * `https://api.example.com`). Anything else, a relative URL with no page to
 * resolve against included, is refused without a request, so a file part cannot
 * point the browser at an arbitrary host or at a loopback service.
 */
export const isFetchableUrl = (url: string, allowedOrigins: ReadonlyArray<string>): boolean => {
    const selfOrigin = globalThis.location?.origin;
    let parsed: URL;

    try {
        parsed = new URL(url, selfOrigin);
    } catch {
        return false;
    }

    if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
        return true;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    return parsed.origin === selfOrigin || allowedOrigins.includes(parsed.origin);
};
