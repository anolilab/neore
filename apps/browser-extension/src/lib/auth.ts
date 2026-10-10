import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { APP_URL } from "./env";

/**
 * better-auth against the web app's origin, which proxies `/api/auth/*` to the
 * backend. The session cookie lives on that origin; `credentials: "include"`
 * plus the host permission for it (see `manifest.config.ts`) is what lets the
 * extension page send it. The backend must list this extension's origin in
 * `TRUSTED_EXTENSION_ORIGINS`, or better-auth rejects every credential request
 * from it as cross-origin.
 */
export const authClient = createAuthClient({
    baseURL: APP_URL,
    fetchOptions: { credentials: "include" },
    plugins: [organizationClient()],
});
