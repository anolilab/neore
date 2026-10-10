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
 * Scoped to `serverFn` deliberately. `handlerType === "router"` covers the API
 * routes, and `/api/auth/*` is called cross-origin on purpose: the browser
 * extension authenticates against this app from a `chrome-extension://` origin
 * (see `apps/browser-extension/src/lib/env.ts`). Widening this filter to every
 * request would 403 the extension's entire auth flow.
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
        functionMiddleware: [logMiddleware],
        // Security middleware runs first to set headers and generate nonce — it
        // wraps the downstream response, so a CSRF 403 still carries them.
        requestMiddleware: [securityMiddleware, csrfMiddleware, posthogMiddleware, linguiMiddleware],
    };
});
