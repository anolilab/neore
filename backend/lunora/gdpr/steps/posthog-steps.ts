import { v } from "lunorash/server";

import { internalAction } from "../../_generated/server";
import { assertOk, FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";
import { posthogAppHost } from "../posthog-host";

/**
 * - `deleted`: PostHog accepted the bulk delete.
 * - `no_profile`: PostHog answered 404 for the person AND the configured project exists, so
 *   the person has no PostHog profile and there is nothing to erase. This completes the
 *   deletion workflow: an erasure cannot remove data that is not there.
 * - `skipped`: PostHog deletion is not configured here; NOTHING was erased.
 */
export type PostHogErasureOutcome = "deleted" | "no_profile" | "skipped";

const vPostHogErasureOutcome = v.union(v.literal("deleted"), v.literal("no_profile"), v.literal("skipped"));

interface PostHogErasureEnv {
    POSTHOG_HOST?: string;
    POSTHOG_PERSONAL_API_KEY?: string;
    POSTHOG_PROJECT_ID?: string;
}

/**
 * PostHog answers 404 both for a person it does not know and for a project id that does not
 * exist, so a 404 on the person proves nothing alone. Throws unless the configured project
 * resolves, which keeps a wrong `POSTHOG_PROJECT_ID` from passing as "nothing to erase".
 */
const assertProjectExists = async (host: string, projectId: string, personalApiKey: string): Promise<void> => {
    const response = await fetchWithDeadline(`${host}/api/projects/${projectId}/`, {
        headers: { Authorization: `Bearer ${personalApiKey}` },
        timeoutMs: FETCH_TIMEOUT_SHORT_MS,
    });

    await assertOk(response, `[GDPR/PostHog] Project ${projectId} could not be verified, so a 404 on the person is not trusted`);
    await response.body?.cancel();
};

/**
 * Deletes the person and their events. Anything but a clean answer THROWS, so the workflow
 * step retries and the deletion is never reported as done while data may remain. The one
 * non-2xx that does not throw is a 404 on the person from a verified project (`no_profile`).
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
        // Checked only on a 404 (so at most once per run): every other status already
        // proves the project id resolves or throws below.
        await assertProjectExists(host, projectId, personalApiKey);

        return "no_profile";
    }

    await assertOk(response, `[GDPR/PostHog] Failed to delete person ${userId}`, { includeBody: true });

    return "deleted";
};

export const deletePostHogPerson = internalAction
    .input({ userId: v.string() })
    .output(vPostHogErasureOutcome)
    .action(async ({ args: { userId }, ctx: _context }) => await erasePostHogPerson(userId, process.env));
