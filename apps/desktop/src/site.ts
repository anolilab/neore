/**
 * The deployment this shell wraps, and every URL derived from it. Port of
 * `apps/native/src-tauri/src/site.rs`: same rules, same tests (`site.test.ts`).
 *
 * The origin is fixed at BUILD time (`NEORE_SITE_URL`, see `scripts/build.mjs`).
 * It is also the only origin granted IPC, so a runtime override would let
 * whoever controls the environment point an IPC-capable window at another site.
 */

/** `pnpm dev` compiles against the local Vite server; release builds must set the origin. */
const DEFAULT_SITE_URL = "http://localhost:5173";

/**
 * Thread ids are Lunora document ids. Anything else in a deep link is refused
 * rather than escaped, so a link can never smuggle a path, query or `..`.
 */
const THREAD_ID_PATTERN = /^[\w-]+$/u;

const isValidThreadId = (id: string): boolean => id !== "" && id.length <= 128 && THREAD_ID_PATTERN.test(id);

export type DeepLink = { kind: "compose"; text: string } | { kind: "focus" } | { kind: "open"; url: URL };

export const SCHEME = "neore";

/** Hard cap on text arriving from outside the app (deep links, share sheet). */
export const MAX_COMPOSE_CHARS = 32_000;

/** Strips path, query and fragment. `undefined` for anything but http(s). */
export const originOf = (url: URL): URL | undefined => {
    if (!["http:", "https:"].includes(url.protocol) || url.hostname === "") {
        return undefined;
    }

    return new URL(`${url.origin}/`);
};

/** The origin the shell loads. Throws on a non-http(s) value: that is a build error, not a runtime one. */
export const siteOrigin = (raw: string | undefined = process.env.NEORE_SITE_URL ?? DEFAULT_SITE_URL): URL => {
    const origin = originOf(new URL(raw));

    if (!origin) {
        throw new Error("NEORE_SITE_URL must be an http(s) origin");
    }

    return origin;
};

/** The URL pattern a remote capability would match: every path on the origin. */
export const remotePattern = (origin: URL): string => `${origin.origin}/*`;

export const isSameOrigin = (origin: URL, url: URL): boolean => url.origin === origin.origin;

export const newChatUrl = (origin: URL): URL => new URL("chat", origin);

export const threadUrl = (origin: URL, id: string): URL | undefined => {
    if (id === "default" || !isValidThreadId(id)) {
        return undefined;
    }

    return new URL(`chat/${id}`, origin);
};

/** Trims, then clamps by code points (not UTF-16 units, not bytes). */
export const clampText = (text: string, maxChars: number): string => [...text.trim()].slice(0, maxChars).join("");

/**
 * Maps an incoming `neore://` URL onto an action. Anything unrecognised is
 * `undefined` and ignored: a deep link is untrusted input from any other app.
 */
export const parseDeepLink = (origin: URL, link: URL): DeepLink | undefined => {
    if (link.protocol !== `${SCHEME}:`) {
        return undefined;
    }

    const segments = link.pathname.split("/").filter((part) => part !== "");

    if (link.hostname === "thread" && segments.length === 1) {
        const url = threadUrl(origin, segments[0]);

        return url ? { kind: "open", url } : undefined;
    }

    if (link.hostname === "new" && segments.length === 0) {
        const text = link.searchParams.get("text") ?? undefined;
        const clamped = text === undefined ? "" : clampText(text, MAX_COMPOSE_CHARS);

        return clamped === "" ? { kind: "focus" } : { kind: "compose", text: clamped };
    }

    if (link.hostname === "" && segments.length === 0) {
        return { kind: "focus" };
    }

    return undefined;
};
