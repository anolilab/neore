/**
 * Polling one watched repository, with every effect injected so a test needs no token or host.
 *
 * The order is the invariant: read the row the lease was taken on (gone means the user stopped watching: nothing
 * is fetched), ask the host with the stored ETag and login (an unchanged list is ONE conditional request), and
 * record the answer under the lease. The action at the bottom wires the real ports.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { internalAction } from "../_generated/server";
import type { HostDriver } from "./driver";
import { DEVELOP_DRIVER } from "./develop-driver";
import { cachedRequestsOf } from "./freshness-logic";
import type { ReadOutcome } from "./read-host";
import { readFromHost } from "./read-host";
import type { RepoPoll } from "./types";

export interface PollTarget {
    etag: string | null;
    leasedAt: number;
    login: string | null;
    repository: string;
    userId: string;
}

export type RecordedPoll =
    | { etag: string | null; kind: "changed"; login: string; requested: ReturnType<typeof cachedRequestsOf> }
    | { kind: "failed"; status: Exclude<ReadOutcome<object>["status"], "ok"> }
    | { kind: "not_modified" };

export interface PollPorts {
    fetch: (target: PollTarget) => Promise<ReadOutcome<{ poll: RepoPoll }>>;
    read: () => Promise<PollTarget | null>;
    record: (outcome: RecordedPoll) => Promise<unknown>;
}

/**
 * A read that throws something that is not a host error (a response that fails to parse) is this repository's
 * failure alone: recorded, so it backs off like any other and the repositories after it still poll.
 */
const askHost = async (ports: PollPorts, target: PollTarget): ReturnType<PollPorts["fetch"]> => {
    try {
        return await ports.fetch(target);
    } catch (error) {
        console.error(`[Develop] Polling ${target.repository} failed:`, error);

        return { status: "host_error" };
    }
};

/** Polls the repository the lease was taken on; answers whether anything was asked of the host. */
export const runRepoPoll = async (ports: PollPorts, lease: number): Promise<{ fetched: boolean }> => {
    const target = await ports.read();

    // Unwatched since the dispatch, or a newer lease took the row over: this poll is not wanted any more.
    if (target === null || target.leasedAt !== lease) {
        return { fetched: false };
    }

    const outcome = await askHost(ports, target);

    if (outcome.status !== "ok") {
        await ports.record({ kind: "failed", status: outcome.status });

        return { fetched: true };
    }

    const { poll } = outcome;

    await ports.record(
        poll.status === "not_modified"
            ? { kind: "not_modified" }
            : { etag: poll.etag, kind: "changed", login: poll.login, requested: cachedRequestsOf(poll.requested) },
    );

    return { fetched: true };
};

/** Asks the host through the user's connector token. The token stays in this call. */
export const hostPoll =
    (driver: HostDriver, token: Parameters<typeof readFromHost>[1], via?: Parameters<typeof readFromHost>[3]) => async (target: PollTarget) =>
        await readFromHost(
            driver,
            token,
            async (request) => {
                return { poll: await driver.pollReviewRequests(request, target.repository, { etag: target.etag, login: target.login }) };
            },
            via,
        );

/** The poll the shard tick scheduled (`dispatchDueRepoPolls`), and the one a refresh on open runs for each repository it leased. */
export const pollWatchedRepo = internalAction
    .input({ lease: v.number(), watchId: v.id("watchedRepositories") })
    .output(v.object({ fetched: v.boolean() }))
    .action(
        async ({ args, ctx }) =>
            await runRepoPoll(
                {
                    fetch: async (target) => await hostPoll(DEVELOP_DRIVER, await resolveGithubToken(ctx, target.userId))(target),
                    read: async () => await ctx.runQuery(internal.source_control.freshness_internal.getWatchForPoll, { watchId: args.watchId }),
                    record: async (outcome) =>
                        await ctx.runMutation(internal.source_control.freshness_internal.recordRepoPoll, { lease: args.lease, outcome, watchId: args.watchId }),
                },
                args.lease,
            ),
    );
