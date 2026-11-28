import { describe, expect, it } from "vitest";

import { buildHostGuidePrompt } from "../../source-control/guide-prompt";
import { wakePrompt } from "../../source-control/pr-watch-wake";
import { buildSubAgentPrompt } from "../../sub-agents/logic";
import { roleSystemText } from "../../sub-agents/roles";
import { buildTaskPrompt } from "../../tasks/logic";
import { buildGoalContinuationPrompt } from "../goals/logic";
import { isAppWrittenByText, isAppWrittenInThread, needsThreadTags, PULL_REQUEST_OPENER } from "./app-written-prompts";

/** What the backfill decides for a row: the thread's tags are read only when the row needs them. */
const judged = (row: { order: number; text: string }, tags: string[]): boolean =>
    isAppWrittenByText(row.text) || (needsThreadTags(row) && isAppWrittenInThread(row, tags));

const brief = buildSubAgentPrompt("Fix the flaky test");
const guide = buildHostGuidePrompt({
    baseBranch: "main",
    body: "Body",
    commits: [],
    files: [],
    headBranch: "feature",
    headSha: "a".repeat(40),
    instructions: "",
    number: 7,
    repository: "octo/hello",
    threads: [],
    title: "Title",
});

describe("app-written prompts saved before the mark", () => {
    // Each opening comes from the builder that writes it: a reworded builder fails here, not silently in the backfill.
    it.each([
        ["a task's instructions, in a task's chat", { order: 0, text: buildTaskPrompt({ instructions: "Sum the sales", title: "Report" }) }, ["task"]],
        ["a task's instructions, in a chat it continues", { order: 4, text: buildTaskPrompt({ instructions: "Sum the sales", title: "Report" }) }, ["chat"]],
        ["a goal's later round", { order: 2, text: buildGoalContinuationPrompt({ goal: "Ship it", reason: "Tests fail" }) }, ["chat"]],
        ["a sub-agent's brief", { order: 0, text: brief }, ["sub-agent"]],
        ["a lead's later message to a worker", { order: 3, text: brief }, ["sub-agent", "worker"]],
        ["a host worker's brief after its role", { order: 1, text: `${roleSystemText({ name: "implementation" })}\n\n${brief}` }, ["sub-agent", "worker"]],
        ["a pull request chat's opener", { order: 0, text: `${PULL_REQUEST_OPENER}https://github.com/octo/hello/pull/7` }, ["chat", "develop"]],
        [
            "a pull request wake, in a chat the pull request is linked to",
            { order: 5, text: wakePrompt({ number: 7, repository: "octo/hello" }, ["checks"]) },
            ["chat"],
        ],
        ["the guide's prompt on a paired computer", { order: 0, text: guide }, ["chat", "host"]],
        ["a trigger's rendered template", { order: 0, text: "Summarise today's alerts" }, ["trigger"]],
        ["an eval case", { order: 0, text: "What is the capital of France?" }, ["eval"]],
    ])("finds %s", (_name, row, tags) => {
        expect(judged(row, tags)).toBe(true);
    });

    it.each([
        ["a prompt in a person's chat", { order: 0, text: "Summarise today's alerts" }, ["chat"]],
        ["a person's reply in a trigger's chat", { order: 1, text: "Now only the critical ones" }, ["trigger"]],
        ["a person's message to a worker", { order: 2, text: "Fix the flaky test" }, ["sub-agent", "worker"]],
        ["a brief's words typed in a person's chat", { order: 0, text: brief }, ["chat"]],
        ["the opener's words typed in a person's chat", { order: 0, text: `${PULL_REQUEST_OPENER}https://github.com/octo/hello/pull/7` }, ["chat"]],
        ["an untagged branch's first prompt", { order: 0, text: "Plan the trip" }, []],
    ])("leaves %s typed", (_name, row, tags) => {
        expect(judged(row, tags)).toBe(false);
    });
});
