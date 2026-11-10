const fs = require("node:fs");
const path = require("node:path");

const ARTIFACT_NAME = "thread-transfer-results";
const RESULT_FILE = "thread-transfer-result.json";
const COMMENT_MARKER = "<!-- neore-thread-transfer-report -->";
const SCENARIO_ID = "thread-transfer-v1";
const LIVE_SCENARIO_ID = "thread-transfer-live-v1";

// The two halves are measured by separate test files and merged by `assemble`.
const PART_FILES = { snapshot: "snapshot.json", stream: "stream.json" };
const SNAPSHOT_KEYS = ["snapshotWireBytes", "snapshotDecodedBytes"];
const STREAM_KEYS = ["liveStreamWireBytes", "liveStreamDecodedBytes", "liveStreamMessages"];
const OBSERVED_KEYS = ["totalWireBytes", ...SNAPSHOT_KEYS, ...STREAM_KEYS];
const SCENARIO_KEYS = ["id", "historyTurns", "historyToolCallsPerTurn", "historyToolResultBytes", "measuredToolCalls", "measuredToolResultBytes"];
const LIVE_SCENARIO_KEYS = ["id", "measuredToolCalls", "replyChunks", "replyChunkChars"];
const MAX_RESULT_BYTES = 64 * 1_024;

function resultShaMarker(sha) {
    return `<!-- neore-thread-transfer-result-sha:${sha} -->`;
}

function assertObject(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

function assertExactKeys(value, expected, label) {
    assertObject(value, label);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} has unexpected fields`);
    }
}

function assertMetric(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
        throw new Error(`${label} must be a non-negative safe integer below 1,000,000,000`);
    }
}

function validateScenario(scenario) {
    assertExactKeys(scenario, SCENARIO_KEYS, "result.scenario");
    if (scenario.id !== SCENARIO_ID) {
        throw new Error("result.scenario.id is not supported");
    }
    for (const key of SCENARIO_KEYS.slice(1)) {
        assertMetric(scenario[key], `result.scenario.${key}`);
    }
}

function validateLiveScenario(scenario) {
    assertExactKeys(scenario, LIVE_SCENARIO_KEYS, "stream part scenario");
    if (scenario.id !== LIVE_SCENARIO_ID) {
        throw new Error("stream part scenario.id is not supported");
    }
    for (const key of LIVE_SCENARIO_KEYS.slice(1)) {
        assertMetric(scenario[key], `stream part scenario.${key}`);
    }
}

function validateMetrics(value, keys, label) {
    assertExactKeys(value, keys, label);
    for (const key of keys) {
        assertMetric(value[key], `${label}.${key}`);
    }
}

function validateResult(value) {
    assertExactKeys(value, ["schemaVersion", "scenario", "liveScenario", "observed", "ceiling"], "result");
    if (value.schemaVersion !== 1) {
        throw new Error("result.schemaVersion must be 1");
    }
    validateScenario(value.scenario);
    validateLiveScenario(value.liveScenario);
    validateMetrics(value.observed, OBSERVED_KEYS, "result.observed");
    validateMetrics(value.ceiling, OBSERVED_KEYS, "result.ceiling");
    return value;
}

function validateSnapshotPart(value) {
    assertExactKeys(value, ["schemaVersion", "scenario", "observed", "ceiling"], "snapshot part");
    if (value.schemaVersion !== 1) {
        throw new Error("snapshot part schemaVersion must be 1");
    }
    validateScenario(value.scenario);
    validateMetrics(value.observed, SNAPSHOT_KEYS, "snapshot part observed");
    validateMetrics(value.ceiling, SNAPSHOT_KEYS, "snapshot part ceiling");
    return value;
}

function validateStreamPart(value) {
    assertExactKeys(value, ["schemaVersion", "scenario", "observed", "ceiling"], "stream part");
    if (value.schemaVersion !== 1) {
        throw new Error("stream part schemaVersion must be 1");
    }
    validateLiveScenario(value.scenario);
    validateMetrics(value.observed, STREAM_KEYS, "stream part observed");
    validateMetrics(value.ceiling, STREAM_KEYS, "stream part ceiling");
    return value;
}

function readJsonFile(file, validate) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) {
        throw new Error("thread transfer result must be a regular file smaller than 64 KiB");
    }
    return validate(JSON.parse(fs.readFileSync(file, "utf8")));
}

function readResult(directory) {
    if (!directory) return undefined;
    const file = path.join(directory, RESULT_FILE);
    if (!fs.existsSync(file)) return undefined;
    return readJsonFile(file, validateResult);
}

/**
 * Merges the snapshot and stream halves into one result. The total wire budget is the
 * sum of the two wire budgets, so it needs no constant of its own.
 */
function assemble(snapshot, stream) {
    const snapshotPart = validateSnapshotPart(snapshot);
    const streamPart = validateStreamPart(stream);
    const observed = {
        totalWireBytes: snapshotPart.observed.snapshotWireBytes + streamPart.observed.liveStreamWireBytes,
        ...snapshotPart.observed,
        ...streamPart.observed,
    };
    const ceiling = {
        totalWireBytes: snapshotPart.ceiling.snapshotWireBytes + streamPart.ceiling.liveStreamWireBytes,
        ...snapshotPart.ceiling,
        ...streamPart.ceiling,
    };
    return validateResult({ schemaVersion: 1, scenario: snapshotPart.scenario, liveScenario: streamPart.scenario, observed, ceiling });
}

function assembleFromDirectory(directory) {
    return assemble(
        readJsonFile(path.join(directory, PART_FILES.snapshot), validateSnapshotPart),
        readJsonFile(path.join(directory, PART_FILES.stream), validateStreamPart),
    );
}

function formatBytes(bytes) {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes >= 1_024 * 1_024) return `${(bytes / 1_024 / 1_024).toFixed(2)} MiB`;
    return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatValue(value, kind) {
    return kind === "messages" ? value.toLocaleString("en-US") : formatBytes(value);
}

function formatImpact(current, baseline, kind) {
    if (baseline === undefined) return "—";
    const delta = current - baseline;
    const prefix = delta > 0 ? "+" : delta < 0 ? "−" : "";
    const magnitude = formatValue(Math.abs(delta), kind);
    const percent = baseline === 0 ? "" : ` (${prefix}${Math.abs((delta / baseline) * 100).toFixed(1)}%)`;
    return `${prefix}${magnitude}${percent}`;
}

function sameScenario(left, right) {
    return SCENARIO_KEYS.every((key) => left[key] === right[key]);
}

function sameLiveScenario(left, right) {
    return LIVE_SCENARIO_KEYS.every((key) => left[key] === right[key]);
}

const METRICS = [
    { key: "totalWireBytes", label: "Total thread wire (gzip)", kind: "bytes" },
    { key: "snapshotWireBytes", label: "Thread snapshot wire (gzip)", kind: "bytes" },
    { key: "snapshotDecodedBytes", label: "Thread snapshot decoded", kind: "bytes" },
    { key: "liveStreamWireBytes", label: "Live stream wire (gzip)", kind: "bytes" },
    { key: "liveStreamDecodedBytes", label: "Live stream decoded", kind: "bytes" },
    { key: "liveStreamMessages", label: "Live stream lines", kind: "messages" },
];

function renderComment(input) {
    const current = input.current;
    const baseline = input.baseline;
    const comparable =
        baseline !== undefined && sameScenario(current.scenario, baseline.scenario) && sameLiveScenario(current.liveScenario, baseline.liveScenario);
    // The verdict uses the ceilings the `main` run enforced, so a PR cannot pass by raising its own. Without a baseline, the PR's are the only ones.
    const enforced = baseline ? baseline.ceiling : current.ceiling;
    const rows = [];
    const ceilingChanges = [];
    let failed = false;

    for (const metric of METRICS) {
        const observed = current.observed[metric.key];
        const ceiling = enforced[metric.key];
        const baselineObserved = comparable ? baseline.observed[metric.key] : undefined;
        const pass = observed <= ceiling;
        failed ||= !pass;
        rows.push(
            `| ${metric.label} | ${baselineObserved === undefined ? "—" : formatValue(baselineObserved, metric.kind)} | ${formatValue(observed, metric.kind)} | ${formatImpact(observed, baselineObserved, metric.kind)} | ${formatValue(ceiling, metric.kind)} | ${pass ? "✅" : "❌"} |`,
        );

        if (comparable && baseline.ceiling[metric.key] !== current.ceiling[metric.key]) {
            ceilingChanges.push(
                `- ${metric.label}: ${formatValue(baseline.ceiling[metric.key], metric.kind)} → ${formatValue(current.ceiling[metric.key], metric.kind)}`,
            );
        }
    }

    const baselineLink = input.baselineRun ? `[\`${input.baselineRun.sha.slice(0, 7)}\`](${input.baselineRun.url})` : "unavailable";
    const currentLink = `[\`${input.currentRun.sha.slice(0, 7)}\`](${input.currentRun.url})`;
    const notices = [];
    if (!baseline) {
        notices.push(
            "> ℹ️ No successful `main` baseline artifact is available yet. This run establishes the initial measurement, and its ceilings are the ones this PR declares.",
        );
    } else if (!comparable) {
        notices.push(
            "> ⚠️ The measured workload changed (thread fixture or live reply), so impact percentages are not directly comparable to the `main` baseline.",
        );
    } else if (!input.baselineRun.matchesBase) {
        notices.push("> ℹ️ The exact PR base did not have a successful artifact. Baseline uses the latest successful `main` measurement shown below.");
    }
    if (ceilingChanges.length > 0) {
        notices.push(`> ⚠️ **This PR changes transfer ceilings:**\n>\n${ceilingChanges.map((line) => `> ${line}`).join("\n")}`);
    }

    return [
        COMMENT_MARKER,
        resultShaMarker(input.currentRun.sha),
        "## Thread transfer impact",
        "",
        failed ? "❌ One or more thread transfer ceilings were exceeded." : "✅ Thread transfer remains within every enforced ceiling.",
        ...(notices.length > 0 ? ["", ...notices] : []),
        "",
        "| Metric | Main baseline | This PR | Impact | Ceiling | |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
        ...rows,
        "",
        `Baseline: ${baselineLink} · PR result: ${currentLink} · Source CI: ${input.currentRun.conclusion}`,
        "",
        "<details>",
        "<summary>Scenario</summary>",
        "",
        `${current.scenario.historyTurns} historical turns, ${current.scenario.historyToolCallsPerTurn} tool calls per turn, ${formatBytes(current.scenario.historyToolResultBytes)} retained tool results per historical turn, and a ${formatBytes(current.scenario.measuredToolResultBytes)} retained result in the measured turn (${current.scenario.measuredToolCalls} tool calls).`,
        "",
        `The live reply: ${current.liveScenario.measuredToolCalls} tool progress reports and ${current.liveScenario.replyChunks} text chunks of up to ${current.liveScenario.replyChunkChars} characters each.`,
        "",
        "Wire is the gzip of each body. Decoded is the body as sent. Live stream lines are the NDJSON lines the gateway relays for one reply.",
        "",
        "</details>",
        "",
        "_Updated in place by a trusted workflow. The measurements are the PR run's own output, validated but not independently verified. The ceilings are the `main` baseline's where one exists._",
    ].join("\n");
}

async function artifactsForRun(github, owner, repo, runId) {
    return github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
        owner,
        repo,
        run_id: runId,
        per_page: 100,
    });
}

function findResultArtifact(artifacts) {
    return artifacts.find((artifact) => artifact.name === ARTIFACT_NAME && !artifact.expired);
}

async function resolve({ github, context, core }) {
    const source = context.payload.workflow_run;
    const { owner, repo } = context.repo;
    if (source.event !== "pull_request") {
        core.setOutput("publish", "false");
        return;
    }

    let pullNumber = source.pull_requests?.[0]?.number;
    if (!pullNumber) {
        let associated;
        try {
            associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
                owner,
                repo,
                commit_sha: source.head_sha,
                per_page: 100,
            });
        } catch (error) {
            // A force-pushed or deleted PR head can disappear before this workflow runs.
            if (error.status === 422 && error.response?.data?.message === `No commit found for SHA: ${source.head_sha}`) {
                core.info(`Skipping CI result for unavailable commit ${source.head_sha}.`);
                core.setOutput("publish", "false");
                return;
            }
            throw error;
        }
        const matchingPulls = associated.filter((pull) => pull.state === "open" && pull.head.sha === source.head_sha && pull.head.ref === source.head_branch);
        if (matchingPulls.length !== 1) {
            core.info(
                `Expected one open pull request for ${source.head_repository?.full_name ?? "unknown repository"}:${source.head_branch ?? "unknown branch"} at ${source.head_sha}; found ${matchingPulls.length}.`,
            );
            core.setOutput("publish", "false");
            return;
        }
        pullNumber = matchingPulls[0].number;
    }
    if (!pullNumber) {
        core.info("No open pull request is associated with the completed run.");
        core.setOutput("publish", "false");
        return;
    }

    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (pull.head.sha !== source.head_sha) {
        core.info(`Skipping stale result ${source.head_sha}; PR head is ${pull.head.sha}.`);
        core.setOutput("publish", "false");
        return;
    }

    const sourceArtifacts = await artifactsForRun(github, owner, repo, source.id);
    const sourceArtifact = findResultArtifact(sourceArtifacts);
    // A successful run must produce the artifact; its absence means the measurement was skipped.
    if (!sourceArtifact && source.conclusion === "success") {
        core.info("The run produced no thread transfer measurement; nothing to report.");
        core.setOutput("publish", "false");
        return;
    }
    // One page each for the exact base and the newest runs; paging through
    // every successful main run costs up to ten requests to keep 20.
    const listRuns = async (filters) => {
        const { data } = await github.rest.actions.listWorkflowRuns({
            owner,
            repo,
            workflow_id: source.workflow_id,
            branch: pull.base.ref,
            event: "push",
            status: "success",
            per_page: 20,
            ...filters,
        });
        return data.workflow_runs;
    };
    const [baseRuns, recentRuns] = await Promise.all([listRuns({ head_sha: pull.base.sha }), listRuns({})]);
    const orderedRuns = [...baseRuns, ...recentRuns.filter((run) => run.head_sha !== pull.base.sha)].slice(0, 20);

    let baselineRun;
    for (const run of orderedRuns) {
        const artifacts = await artifactsForRun(github, owner, repo, run.id);
        if (findResultArtifact(artifacts)) {
            baselineRun = run;
            break;
        }
    }

    core.setOutput("publish", "true");
    core.setOutput("pull_number", String(pullNumber));
    core.setOutput("pr_artifact", sourceArtifact ? "true" : "false");
    core.setOutput("pr_run_id", String(source.id));
    core.setOutput("pr_sha", source.head_sha);
    core.setOutput("pr_conclusion", source.conclusion ?? "unknown");
    core.setOutput("baseline_artifact", baselineRun ? "true" : "false");
    core.setOutput("baseline_run_id", baselineRun ? String(baselineRun.id) : "");
    core.setOutput("baseline_sha", baselineRun?.head_sha ?? "");
    core.setOutput("baseline_matches_base", baselineRun?.head_sha === pull.base.sha ? "true" : "false");
}

async function upsertComment(github, context, pullNumber, body, options = {}) {
    const { owner, repo } = context.repo;
    const comments = await github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
    });
    const existing = comments.find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(COMMENT_MARKER));
    if (options.preserveResultSha && existing?.body?.includes(resultShaMarker(options.preserveResultSha))) {
        return;
    }
    if (existing) {
        await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    } else {
        await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
    }
}

async function upsertCommentForCurrentHead(github, context, core, pullNumber, expectedSha, body, options) {
    const { owner, repo } = context.repo;
    const { data: pull } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
    });
    if (pull.head.sha !== expectedSha) {
        core.info(`Skipping stale result ${expectedSha}; PR head is ${pull.head.sha}.`);
        return false;
    }

    await upsertComment(github, context, pullNumber, body, options);
    return true;
}

async function publish({ github, context, core }) {
    const pullNumber = Number(process.env.PR_NUMBER);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
        throw new Error("PR_NUMBER is invalid");
    }

    const current = readResult(process.env.PR_RESULT_DIR);
    const currentRun = {
        sha: process.env.PR_SHA,
        conclusion: process.env.PR_CONCLUSION,
        url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.PR_RUN_ID}`,
    };
    if (!current) {
        await upsertCommentForCurrentHead(
            github,
            context,
            core,
            pullNumber,
            currentRun.sha,
            [
                COMMENT_MARKER,
                "## Thread transfer impact",
                "",
                `⚠️ The latest [run](${currentRun.url}) did not produce a thread transfer result for \`${currentRun.sha.slice(0, 7)}\`.`,
                "",
                "_This comment will update automatically after the next completed run._",
            ].join("\n"),
            { preserveResultSha: currentRun.sha },
        );
        return;
    }

    const baseline = readResult(process.env.BASELINE_RESULT_DIR);
    const baselineRun = baseline
        ? {
              sha: process.env.BASELINE_SHA,
              matchesBase: process.env.BASELINE_MATCHES_BASE === "true",
              url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${process.env.BASELINE_RUN_ID}`,
          }
        : undefined;
    const body = renderComment({ current, baseline, currentRun, baselineRun });
    const published = await upsertCommentForCurrentHead(github, context, core, pullNumber, currentRun.sha, body);
    if (published) {
        core.info(`Updated thread transfer report on PR #${pullNumber}.`);
    }
}

module.exports = {
    assemble,
    publish,
    renderComment,
    resolve,
    validateResult,
};

// `node thread-transfer-report.cjs assemble <parts-dir> <result-file>` runs in the
// measurement job, which writes the one artifact the publisher later downloads.
if (require.main === module) {
    const [command, partsDir, resultFile] = process.argv.slice(2);
    if (command !== "assemble" || !partsDir || !resultFile) {
        console.error("usage: thread-transfer-report.cjs assemble <parts-dir> <result-file>");
        process.exit(2);
    }
    const result = assembleFromDirectory(partsDir);
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
}
