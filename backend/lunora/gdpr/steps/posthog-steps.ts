import { v } from "lunorash/server";

import { internalAction } from "../../_generated/server";
import { assertOk, FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";
import { posthogAppHost } from "../posthog-host";

/**
 * - `deleted`: PostHog accepted the bulk delete.
 * - `not_found`: PostHog has no such person, so there is nothing to erase.
 * - `skipped`: PostHog deletion is not configured here; NOTHING was erased.
 */
export type PostHogErasureOutcome = "deleted" | "not_found" | "skipped";

const vPostHogErasureOutcome = v.union(v.literal("deleted"), v.literal("not_found"), v.literal("skipped"));

interface PostHogErasureEnv {
    POSTHOG_HOST?: string;
    POSTHOG_PERSONAL_API_KEY?: string;
    POSTHOG_PROJECT_ID?: string;
}

/**
 * Deletes the person and their events. Any failure other than "no such person"
 * THROWS, so the workflow step retries and the deletion is never reported as
 * done while data may remain.
 */
export const erasePostHogPerson = async (userId: string, env: PostHogErasureEnv): Promise<PostHogErasureOutcome> => {
    const personalApiKey = env.POSTHOG_PERSONAL_API_KEY;
    const projectId = env.POSTHOG_PROJECT_ID;

    if (!personalApiKey || !projectId) {
        // PostHog GDPR deletion not configured — nothing to erase, and the caller must not call it erased.
        return "skipped";
    }

    // The private API lives on the app host, not on the ingestion host `POSTHOG_HOST` names.
    const host = posthogAppHost(env.POSTHOG_HOST);
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

    if (response.status === 404) {
        await response.body?.cancel();

        return "not_found";
    }

    await assertOk(response, `[GDPR/PostHog] Failed to delete person ${userId}`, { includeBody: true });

    return "deleted";
};

export const deletePostHogPerson = internalAction
    .input({ userId: v.string() })
    .output(vPostHogErasureOutcome)
    .action(async ({ args: { userId }, ctx: _context }) => await erasePostHogPerson(userId, process.env));
