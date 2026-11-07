/**
 * The usage page's organization view (`usage_organization.getOrganizationProjectUsage`): one call, which sums the
 * organization's usage ledger on the server. Pinned by `usage-organization.test.ts`.
 */

import { TransportError } from "@lunora/client";
import { getErrorCode, isForbiddenError } from "@lunora/react";

/**
 * Whether a failed organization read is worth one more try: only a failure that may not repeat — a network failure or
 * a transport error such as a timeout (coded `INTERNAL`, but no answer from the backend) — never a refusal or any other
 * answer from the backend, which would only come back the same.
 */
export const retryOrganizationRead = (failureCount: number, error: unknown): boolean => {
    if (failureCount >= 1 || isForbiddenError(error)) {
        return false;
    }

    return error instanceof TransportError || getErrorCode(error) === undefined;
};
