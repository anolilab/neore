import { parse, serialize } from "cookie-es";

import { DEFAULT_LOCALE, extractLocaleFromPath, isLocaleValid, shouldIgnorePath } from "./shared";

const EN_PREFIX_RE = /^\/en(?:\/|$)/;
const EN_PREFIX_STRIP_RE = /^\/en(?=\/|$)/;

type LocaleResult = {
    headers?: { key: string; value: string }[];
    locale: string;
    /** When set, the middleware must issue a 301 redirect to this URL. */
    redirect?: string;
};

const getLocaleFromRequest = (request: Request): LocaleResult => {
    const { headers } = request;
    const url = new URL(request.url);
    const { pathname } = url;

    // Step 1: /en/* -> redirect to strip the redundant /en prefix (prevents duplicate content)
    if (EN_PREFIX_RE.test(pathname)) {
        const newPathname = pathname.replace(EN_PREFIX_STRIP_RE, "") || "/";
        const redirectUrl = new URL(url.href);

        redirectUrl.pathname = newPathname;

        return { locale: DEFAULT_LOCALE, redirect: redirectUrl.href };
    }

    // Step 2: Extract locale from URL path
    const urlLocale = extractLocaleFromPath(pathname);

    if (urlLocale) {
        // Step 2a: If the path after stripping the locale is an ignored route,
        // redirect to strip the locale prefix (ignored paths stay cookie-based).
        const strippedPath = pathname.replace(new RegExp(`^/${urlLocale}(?=/|$)`), "") || "/";

        if (shouldIgnorePath(strippedPath)) {
            const redirectUrl = new URL(url.href);

            redirectUrl.pathname = strippedPath;

            return { locale: DEFAULT_LOCALE, redirect: redirectUrl.href };
        }

        // Step 2b: Valid locale in URL — sync the cookie if it differs.
        const cookie = parse(headers.get("cookie") ?? "");

        if (cookie.locale !== urlLocale) {
            return {
                headers: [
                    {
                        key: "Set-Cookie",
                        value: serialize("locale", urlLocale, {
                            maxAge: 30 * 24 * 60 * 60,
                            path: "/",
                        }),
                    },
                ],
                locale: urlLocale,
            };
        }

        return { locale: urlLocale };
    }

    // Step 3: Query param ?locale= (legacy support)
    const queryLocale = url.searchParams.get("locale") ?? "";

    if (isLocaleValid(queryLocale)) {
        return {
            headers: [
                {
                    key: "Set-Cookie",
                    value: serialize("locale", queryLocale, {
                        maxAge: 30 * 24 * 60 * 60,
                        path: "/",
                    }),
                },
            ],
            locale: queryLocale,
        };
    }

    // Step 4: Cookie
    const cookie = parse(headers.get("cookie") ?? "");

    if (cookie.locale && isLocaleValid(cookie.locale)) {
        return { locale: cookie.locale };
    }

    // Step 5: Accept-Language header (first tag only, e.g. "de,en-US;q=0.9" -> "de")
    const acceptedLanguage = headers.get("accept-language") ?? "";

    if (acceptedLanguage) {
        const firstLang = acceptedLanguage.split(",", 1)[0]?.split(";", 1)[0]?.trim().split("-", 1)[0] ?? "";

        if (firstLang && isLocaleValid(firstLang)) {
            return { locale: firstLang };
        }
    }

    // Step 6: Default — set cookie so future requests are resolved via cookie
    return {
        headers: [
            {
                key: "Set-Cookie",
                value: serialize("locale", DEFAULT_LOCALE, {
                    maxAge: 30 * 24 * 60 * 60,
                    path: "/",
                }),
            },
        ],
        locale: DEFAULT_LOCALE,
    };
};

export default getLocaleFromRequest;
