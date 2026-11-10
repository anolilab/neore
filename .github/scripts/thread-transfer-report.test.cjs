const assert = require("node:assert/strict");
const test = require("node:test");

const { assemble, renderComment, resolve, validateResult } = require("./thread-transfer-report.cjs");

const SCENARIO = {
    id: "thread-transfer-v1",
    historyTurns: 10,
    historyToolCallsPerTurn: 5,
    historyToolResultBytes: 900_000,
    measuredToolCalls: 20,
    measuredToolResultBytes: 1_100_000,
};

function snapshotPart(overrides = {}) {
    return {
        schemaVersion: 1,
        scenario: SCENARIO,
        observed: { snapshotWireBytes: 40_000, snapshotDecodedBytes: 200_000, ...overrides },
        ceiling: { snapshotWireBytes: 50_000, snapshotDecodedBytes: 250_000 },
    };
}

const LIVE_SCENARIO = { id: "thread-transfer-live-v1", measuredToolCalls: 20, replyChunkChars: 100, replyChunks: 60 };

function streamPart({ observed = {}, ceiling = {}, scenario = LIVE_SCENARIO } = {}) {
    return {
        schemaVersion: 1,
        scenario,
        observed: { liveStreamWireBytes: 2_000, liveStreamDecodedBytes: 9_000, liveStreamMessages: 40, ...observed },
        ceiling: { liveStreamWireBytes: 2_500, liveStreamDecodedBytes: 11_000, liveStreamMessages: 50, ...ceiling },
    };
}

function result() {
    return assemble(snapshotPart(), streamPart());
}

test("validates the fixed result schema", () => {
    assert.equal(validateResult(result()).schemaVersion, 1);
    assert.throws(() => validateResult({ ...result(), injectedMarkdown: "@everyone" }), /unexpected fields/);
    assert.throws(() => validateResult({ ...result(), observed: { ...result().observed, totalWireBytes: "lots" } }), /non-negative safe integer/);
    assert.throws(() => validateResult({ ...result(), scenario: { ...SCENARIO, id: "other" } }), /scenario.id is not supported/);
    assert.throws(() => validateResult({ ...result(), liveScenario: { ...LIVE_SCENARIO, id: "other" } }), /scenario.id is not supported/);
});

test("assembles both halves and budgets the total as the sum of the wire budgets", () => {
    const merged = assemble(snapshotPart(), streamPart());

    assert.equal(merged.observed.totalWireBytes, 42_000);
    assert.equal(merged.ceiling.totalWireBytes, 52_500);
    assert.equal(merged.observed.liveStreamMessages, 40);
    assert.deepEqual(merged.scenario, SCENARIO);
});

test("rejects a half with extra fields, so a stray key cannot reach the comment", () => {
    assert.throws(() => assemble({ ...snapshotPart(), body: "@everyone" }, streamPart()), /unexpected fields/);
    assert.throws(() => assemble(snapshotPart(), { ...streamPart(), extra: 1 }), /unexpected fields/);
});

test("reports a passing run with the initial-measurement notice when no baseline exists", () => {
    const body = renderComment({
        current: result(),
        currentRun: { sha: "abcdef1234", conclusion: "success", url: "https://example.test/run/1" },
    });

    assert.match(body, /^<!-- neore-thread-transfer-report -->/);
    assert.match(body, /Thread transfer remains within every enforced ceiling/);
    assert.match(body, /No successful `main` baseline artifact is available yet/);
});

test("reports a failing run when a metric exceeds its ceiling", () => {
    const body = renderComment({
        current: assemble(snapshotPart({ snapshotWireBytes: 60_000 }), streamPart()),
        currentRun: { sha: "abcdef1234", conclusion: "success", url: "https://example.test/run/1" },
    });

    assert.match(body, /One or more thread transfer ceilings were exceeded/);
    assert.match(body, /❌/);
});

test("reports a ceiling change against a comparable baseline", () => {
    const baseline = assemble(snapshotPart(), streamPart());
    const current = assemble(snapshotPart(), streamPart());
    current.ceiling.liveStreamMessages = 60;

    const body = renderComment({
        current,
        baseline,
        baselineRun: { matchesBase: true, sha: "1111111", url: "https://example.test/run/0" },
        currentRun: { sha: "abcdef1234", conclusion: "success", url: "https://example.test/run/1" },
    });

    assert.match(body, /This PR changes transfer ceilings/);
    assert.match(body, /Live stream lines: 50 → 60/);
});

test("judges the PR against the baseline's ceilings, so a PR cannot pass by raising its own", () => {
    const baseline = assemble(snapshotPart(), streamPart());
    const current = assemble(snapshotPart(), streamPart({ observed: { liveStreamMessages: 60 }, ceiling: { liveStreamMessages: 100 } }));

    const body = renderComment({
        current,
        baseline,
        baselineRun: { matchesBase: true, sha: "1111111", url: "https://example.test/run/0" },
        currentRun: { sha: "abcdef1234", conclusion: "success", url: "https://example.test/run/1" },
    });

    assert.match(body, /One or more thread transfer ceilings were exceeded/);
});

test("does not call a run comparable when the live reply workload changed", () => {
    const baseline = assemble(snapshotPart(), streamPart());
    const current = assemble(snapshotPart(), streamPart({ scenario: { ...LIVE_SCENARIO, measuredToolCalls: 40 } }));

    const body = renderComment({
        current,
        baseline,
        baselineRun: { matchesBase: true, sha: "1111111", url: "https://example.test/run/0" },
        currentRun: { sha: "abcdef1234", conclusion: "success", url: "https://example.test/run/1" },
    });

    assert.match(body, /measured workload changed/);
    assert.match(body, /\| Live stream lines \| — \| 40 \| — \|/);
});

function fakeGithub({ pull, sourceArtifacts, baseRuns, recentRuns, artifactsByRun }) {
    const listWorkflowRunArtifacts = () => {};
    const listPullRequestsAssociatedWithCommit = () => {};
    return {
        paginate: async (method, input) => {
            if (method === listWorkflowRunArtifacts) {
                return input.run_id === 2 ? sourceArtifacts : (artifactsByRun[input.run_id] ?? []);
            }
            if (method === listPullRequestsAssociatedWithCommit) {
                return [];
            }
            throw new Error("unexpected pagination call");
        },
        rest: {
            actions: {
                listWorkflowRunArtifacts,
                listWorkflowRuns: async ({ head_sha: headSha }) => ({
                    data: { workflow_runs: (headSha === undefined ? recentRuns : baseRuns).slice(0, 20) },
                }),
            },
            pulls: { get: async () => ({ data: pull }) },
            repos: { listPullRequestsAssociatedWithCommit },
        },
    };
}

async function resolveWith(github) {
    const outputs = {};
    await resolve({
        github,
        context: {
            repo: { owner: "anolilab", repo: "neore" },
            payload: {
                workflow_run: {
                    id: 2,
                    conclusion: "success",
                    event: "pull_request",
                    head_branch: "feature",
                    head_sha: "head-sha",
                    workflow_id: 3,
                    pull_requests: [{ number: 7 }],
                },
            },
        },
        core: {
            info: () => {},
            setOutput: (key, value) => {
                outputs[key] = value;
            },
        },
    });
    return outputs;
}

test("publishes against the exact base's baseline artifact", async () => {
    const outputs = await resolveWith(
        fakeGithub({
            pull: { head: { sha: "head-sha" }, base: { sha: "base-sha", ref: "main" } },
            sourceArtifacts: [{ name: "thread-transfer-results", expired: false }],
            baseRuns: [{ id: 90, head_sha: "base-sha" }],
            recentRuns: [{ id: 91, head_sha: "newer-sha" }],
            artifactsByRun: { 90: [{ name: "thread-transfer-results", expired: false }] },
        }),
    );

    assert.equal(outputs.publish, "true");
    assert.equal(outputs.pull_number, "7");
    assert.equal(outputs.pr_artifact, "true");
    assert.equal(outputs.baseline_run_id, "90");
    assert.equal(outputs.baseline_matches_base, "true");
});

test("skips a result whose commit is no longer the PR head", async () => {
    const outputs = await resolveWith(
        fakeGithub({
            pull: { head: { sha: "newer-head" }, base: { sha: "base-sha", ref: "main" } },
            sourceArtifacts: [{ name: "thread-transfer-results", expired: false }],
            baseRuns: [],
            recentRuns: [],
            artifactsByRun: {},
        }),
    );

    assert.equal(outputs.publish, "false");
});

test("does not publish a successful run that produced no measurement", async () => {
    const outputs = await resolveWith(
        fakeGithub({
            pull: { head: { sha: "head-sha" }, base: { sha: "base-sha", ref: "main" } },
            sourceArtifacts: [],
            baseRuns: [],
            recentRuns: [],
            artifactsByRun: {},
        }),
    );

    assert.equal(outputs.publish, "false");
});
