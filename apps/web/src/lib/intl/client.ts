import type { I18n } from "@lingui/core";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { DEFAULT_LOCALE, extractLocaleFromPath, parseLocaleCookie, shouldIgnorePath } from "./shared";

// Re-export everything from shared so existing import paths keep working
export { DEFAULT_LOCALE, extractLocaleFromPath, isLocaleValid, locales, parseLocaleCookie, shouldIgnorePath } from "./shared";

/**
 * We do a dynamic import of just the catalog that we need.
 */
export const dynamicActivate = async (i18n: I18n, locale: string): Promise<void> => {
    const { messages } = await import(`../../locales/${locale}/messages.po`);

    i18n.loadAndActivate({ locale, messages });
};

/**
 * Strips a locale prefix from the URL path for router rewrite.input.
 * Returns undefined (no rewrite needed) or a new URL with the locale stripped.
 *   /de/auth/sign-in  ->  /auth/sign-in
 *   /de/              ->  /
 *   /about            ->  undefined (nothing to strip).
 */
export const deLocalizeUrl = ({ url }: { url: URL }): URL | undefined => {
    const locale = extractLocaleFromPath(url.pathname);

    if (!locale) {
        return undefined;
    }

    const newPathname = url.pathname.replace(new RegExp(`^/${locale}(?=/|$)`), "") || "/";
    const newUrl = new URL(url.href);

    newUrl.pathname = newPathname;

    return newUrl;
};

/**
 * Determines the current locale isomorphically.
 *   Server: reads from getRequest() URL, then falls back to cookie.
 *   Client: reads from window.location.pathname, then falls back to document.cookie.
 */
export const getCurrentLocale = createIsomorphicFn()
    .server(() => {
        try {
            const request = getRequest();
            const { pathname } = new URL(request.url);
            const urlLocale = extractLocaleFromPath(pathname);

            if (urlLocale && !shouldIgnorePath(pathname)) {
                return urlLocale;
            }

            return parseLocaleCookie(request.headers.get("cookie") ?? "") ?? DEFAULT_LOCALE;
        } catch {
            return DEFAULT_LOCALE;
        }
    })
    .client(() => {
        const urlLocale = extractLocaleFromPath(globalThis.location.pathname);

        if (urlLocale) {
            return urlLocale;
        }

        return parseLocaleCookie(document.cookie) ?? DEFAULT_LOCALE;
    });

/**
 * Adds a locale prefix to the URL path for router rewrite.output.
 * Returns undefined (no rewrite) or a new URL with /{locale} prepended.
 *   Current locale "de", url.pathname "/auth/sign-in"  ->  /de/auth/sign-in
 *   Current locale "en" (default)                      ->  undefined
 *   Ignored path "/chat/123"                           ->  undefined.
 */
export const localizeUrl = ({ url }: { url: URL }): URL | undefined => {
    const locale = getCurrentLocale();

    if (!locale || locale === DEFAULT_LOCALE) {
        return undefined;
    }

    if (shouldIgnorePath(url.pathname)) {
        return undefined;
    }

    // Already has the correct prefix — no change needed
    if (url.pathname.startsWith(`/${locale}/`) || url.pathname === `/${locale}`) {
        return undefined;
    }

    const newUrl = new URL(url.href);

    newUrl.pathname = `/${locale}${url.pathname === "/" ? "" : url.pathname}`;

    return newUrl;
};
