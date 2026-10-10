/**
 * Pure utilities shared between client.ts and server.ts.
 * No browser-only or server-only imports — safe for both environments.
 */

const LOCALE_PREFIX_RE = /^\/([a-z]{2})(?:\/|$)/;
const UNLOCALIZED_PATH_RE = /^\/(?:api|chat|workflow|dashboard)(?:\/|$)/;
const LOCALE_COOKIE_RE = /(?:^|;\s*)locale=([^;]+)/;

export const DEFAULT_LOCALE = "en";

export const locales: Record<string, string> = {
    de: "DE",
    en: "EN",
    es: "ES",
    fr: "FR",
    it: "IT",
    ja: "JA",
    pl: "PL",
    pt: "PT",
    zh: "ZH",
};

export const isLocaleValid = (locale: string): boolean => Object.keys(locales).includes(locale);

/**
 * Extracts a valid non-default locale from a URL pathname.
 *   /de/about  -> "de"
 *   /about     -> null
 *   /en/about  -> null  (en is the default locale, no prefix needed).
 */
export const extractLocaleFromPath = (pathname: string): string | null => {
    const match = LOCALE_PREFIX_RE.exec(pathname);

    if (match && isLocaleValid(match[1] ?? "") && match[1] !== DEFAULT_LOCALE) {
        return match[1] ?? null;
    }

    return null;
};

/**
 * Returns true for paths that must not carry a locale prefix
 * (authenticated / API routes — handled via cookie only).
 */
export const shouldIgnorePath = (pathname: string): boolean => UNLOCALIZED_PATH_RE.test(pathname);

/**
 * Parses the "locale" cookie value from a raw Cookie header string.
 * Uses an inline regex instead of cookie-es to avoid circular deps.
 */
export const parseLocaleCookie = (cookieString: string): string | null => {
    const match = LOCALE_COOKIE_RE.exec(cookieString);

    if (match && isLocaleValid(match[1] ?? "")) {
        return match[1] ?? null;
    }

    return null;
};
