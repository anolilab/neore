import { setupI18n } from "@lingui/core";
import { createMiddleware } from "@tanstack/react-start";

import { dynamicActivate } from "@/lib/intl/client";
import getLocaleFromRequest from "@/lib/intl/server";

const linguiMiddleware = createMiddleware({ type: "request" }).server(async ({ next, request }) => {
    const { headers, locale, redirect } = getLocaleFromRequest(request);

    // Issue a 301 redirect early (e.g. /en/* -> /*, /de/chat/* -> /chat/*).
    // Security middleware wraps this result and adds its headers automatically.
    if (redirect) {
        return new Response(null, {
            headers: { Location: redirect },
            status: 301,
        }) as never;
    }

    const i18n = setupI18n();

    await dynamicActivate(i18n, locale);

    const result = await next({
        context: {
            i18n,
            locale,
        },
    });

    if (headers && headers.length > 0) {
        // A `Response` produced by `fetch` (which is what the better-auth handler
        // returns) has IMMUTABLE headers — appending to them throws
        // `TypeError: Can't modify immutable headers` and the whole request 500s.
        // That took out every `/api/auth/*` call made through the app.
        //
        // Copying into a fresh `Headers` and rebuilding the response is the only
        // way to add to them.
        const merged = new Headers(result.response.headers);

        headers.forEach(({ key, value }) => {
            merged.append(key, value);
        });

        return {
            ...result,
            response: new Response(result.response.body, {
                headers: merged,
                status: result.response.status,
                statusText: result.response.statusText,
            }),
        };
    }

    return result;
});

export default linguiMiddleware;
