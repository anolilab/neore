import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * The `reason` `POST /extension/auth/authorize` gives when an admin impersonating the user tries to sign an app in
 * (`EXTENSION_GRANT_IMPERSONATING`, `backend/lunora/auth/extension-grant.ts`). Its `error` is OAuth's shared `access_denied`.
 */
const IMPERSONATING = "impersonating";

/** A refusal of `POST /extension/auth/authorize`, as its JSON body carries it. */
export interface AppSignInRefusal {
    error?: string;
    message?: string;
    reason?: string;
}

/**
 * What the app sign-in page shows for a refusal, in the user's language where the page knows the refusal; any other
 * refusal shows the backend's own message, and a body without one a generic line.
 */
const appSignInRefusal = (body: AppSignInRefusal, i18n: Pick<I18n, "_">): string => {
    if (body.error === "access_denied" && body.reason === IMPERSONATING) {
        return i18n._(msg`Apps can't be signed in while impersonating. Sign in as yourself to connect one.`);
    }

    return body.message ?? i18n._(msg`The extension could not be connected.`);
};

export default appSignInRefusal;
