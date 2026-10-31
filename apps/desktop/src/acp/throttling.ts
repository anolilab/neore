/**
 * What a hidden desktop window costs a remote command (plans/acp-agent-host.md §4.5, §10 Q4; method in
 * plans/acp-s4-throttling.md). Only the page relay, which claims commands, and the heartbeat run in the window
 * and can slip; the main process posts turn output from its own timers. Two numbers decide whether background
 * throttling stays on: how long a command waits to be claimed, and the longest silence between heartbeats.
 */

/** Budgets: claim latency under 10 s at the 95th percentile, no heartbeat gap over 60 s. */
export const CLAIM_P95_BUDGET_MS = 10_000;
export const HEARTBEAT_GAP_BUDGET_MS = 60_000;

export interface ClaimSample {
    claimedAt: number;
    createdAt: number;
}

export interface ThrottlingSummary {
    claimP95Ms: number | undefined;
    claims: number;
    heartbeats: number;
    maxHeartbeatGapMs: number | undefined;
    passed: boolean | undefined;
}

/** The nearest-rank percentile of a sorted list: the smallest value at least `p` of the list is not above. */
const percentile = (sorted: number[], p: number): number | undefined => {
    if (sorted.length === 0) {
        return undefined;
    }

    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

/**
 * `heartbeats` are the distinct `lastSeenAt` values seen over the hour, in any order. Passed only when there is
 * something to judge on both counts: an hour with no commands measured nothing about the relay.
 */
export const summarize = (claims: ClaimSample[], heartbeats: number[]): ThrottlingSummary => {
    // `sort` on a fresh copy: the desktop's tsconfig `lib` predates `toSorted`.
    // eslint-disable-next-line unicorn/no-array-sort
    const latencies = claims.map((claim) => claim.claimedAt - claim.createdAt).sort((a, b) => a - b);
    // eslint-disable-next-line unicorn/no-array-sort
    const beats = [...new Set(heartbeats)].sort((a, b) => a - b);
    const gaps = beats.slice(1).map((beat, index) => beat - (beats[index] as number));
    const claimP95Ms = percentile(latencies, 0.95);
    const maxHeartbeatGapMs = gaps.length === 0 ? undefined : Math.max(...gaps);

    return {
        claimP95Ms,
        claims: claims.length,
        heartbeats: beats.length,
        maxHeartbeatGapMs,
        passed: claimP95Ms === undefined || maxHeartbeatGapMs === undefined ? undefined : claimP95Ms < CLAIM_P95_BUDGET_MS && maxHeartbeatGapMs <= HEARTBEAT_GAP_BUDGET_MS,
    };
};
