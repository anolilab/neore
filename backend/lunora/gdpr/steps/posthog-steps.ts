import { v } from "lunorash/server";

import { internalAction } from "../../_generated/server";
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";

export const deletePostHogPerson = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx: _context }) => {
        const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
        const projectId = process.env.POSTHOG_PROJECT_ID;

        if (!personalApiKey || !projectId) {
            // PostHog GDPR deletion not configured — skip silently
            return null;
        }

        // The private API lives on the app host (`eu.posthog.com`), not on the ingestion host
        // `POSTHOG_HOST` names (`eu.i.posthog.com`), which the error-tracking sink posts to.
        const host = (process.env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/+$/u, "");
        // Use the Persons v3 bulk-delete endpoint which accepts distinct_ids directly
        const url = `${host}/api/projects/${projectId}/persons/bulk_delete/`;

        const response = await fetchWithDeadline(url, {
            body: JSON.stringify({
                delete_events: true,
                distinct_ids: [userId],
            }),
            headers: {
                Authorization: `Bearer ${personalApiKey}`,
                "Content-Type": "application/json",
            },
            method: "POST",
            timeoutMs: FETCH_TIMEOUT_SHORT_MS,
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");

            console.error(`[GDPR/PostHog] Failed to delete person ${userId}: ${response.status} ${response.statusText}`, body);
        }

        return null;
    });
