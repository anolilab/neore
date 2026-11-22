import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import linguiMiddleware from "./middleware/lingui-middleware";
import logMiddleware from "./middleware/logging-middleware";
import posthogMiddleware from "./middleware/posthog-middleware";
import securityMiddleware from "./middleware/security-middleware";

/**
 * Server functions are same-origin RPC endpoints reachable by any page that can
 * make a request to this origin, so they need an origin check of their own —
 * `securityMiddleware` sets response headers and does not gate the request.
 *
 * Scoped to `serverFn`. `handlerType === "router"` covers the API routes, which
 * this filter leaves alone; widening it means checking every cross-origin caller
 * of those routes first. The browser extension is not one: it signs in through an
 * app grant against the backend (`backend/lunora/auth/extension-grant.ts`) and
 * only opens this app in its sign-in window.
 *
 * The default policy is `Sec-Fetch-Site: same-origin`, falling back to `Origin`
 * and then `Referer`; a request carrying none of the three is rejected
 * (`allowRequestsWithoutOriginCheck` stays off).
 */
const csrfMiddleware = createCsrfMiddleware({
    filter: (context) => context.handlerType === "serverFn",
});

export const startInstance = createStart(() => {
    return {
        // Development only: it logs every server-function call, and production logs are not for that.
        functionMiddleware: import.meta.env.DEV ? [logMiddleware] : [],
        // Security middleware runs first to set headers and generate nonce — it
        // wraps the downstream response, so a CSRF 403 still carries them.
        requestMiddleware: [securityMiddleware, csrfMiddleware, posthogMiddleware, linguiMiddleware],
    };
});
