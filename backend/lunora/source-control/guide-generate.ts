/**
 * Generating a guide: read the pull request, ask a model, assemble. The reads go through the driver's
 * read members only (`GuideReads`), so nothing here can reach a host write, and the model's answer goes
 * through `assembleGuide` before anything is kept.
 */
import type { HostDriver } from "./driver";
import type { AssembledGuide } from "./guide-logic";
import { assembleGuide } from "./guide-logic";
import type { GuidePromptInput } from "./guide-prompt";
import { buildCloudGuidePrompt } from "./guide-prompt";
import type { HostRequest } from "./origin-fetch";
import type { PullRequestFile, PullRequestRef } from "./types";

export type GuideReads = Pick<HostDriver, "getPullRequest" | "listCommits" | "listFiles" | "listThreads" | "view">;

/** A pull request's pages are read within the host's own ceiling, plus the one page that shows nothing is left. */
const PAGE_SIZE = 100;

export interface PullRequestForGuide {
    baseBranch: string;
    body: string;
    commits: GuidePromptInput["commits"];
    files: PullRequestFile[];
    headBranch: string;
    headSha: string;
    leftOut: number;
    number: number;
    repository: string;
    threads: GuidePromptInput["threads"];
    title: string;
}

/** Everything a guide is written from, read once. The head is the one the host reports NOW, not the page's. */
export const readPullRequestForGuide = async (driver: GuideReads, request: HostRequest, ref: PullRequestRef): Promise<PullRequestForGuide> => {
    const detail = await driver.getPullRequest(request, ref);
    const { limits } = driver.view;
    const maxPages = Math.ceil(limits.files / PAGE_SIZE);
    const files: PullRequestFile[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
        const result = await driver.listFiles(request, ref, page);

        files.push(...result.files);

        if (!result.hasMore) {
            break;
        }
    }

    const [commits, threads] = await Promise.all([driver.listCommits(request, ref, 1), driver.listThreads(request, ref, null)]);

    const listed = files.slice(0, limits.files);

    return {
        baseBranch: detail.baseBranch,
        body: detail.body,
        commits: commits.commits.map((commit) => {
            return { message: commit.message };
        }),
        files: listed,
        headBranch: detail.headBranch,
        headSha: detail.headSha,
        leftOut: Math.max(0, detail.changedFiles - listed.length),
        number: detail.number,
        repository: detail.repository,
        threads: threads.items.map((thread) => {
            return {
                comments: thread.comments.map((comment) => {
                    return { authorLogin: comment.authorLogin, body: comment.body };
                }),
                path: thread.path,
            };
        }),
        title: detail.title,
    };
};

export const promptInputOf = (read: PullRequestForGuide, instructions: string): GuidePromptInput => {
    return { ...read, instructions };
};

/** What asks the model: the prompt in, the model's parsed answer out. Its answer is untrusted, like the pull request. */
export type AskModel = (prompt: { prompt: string; system: string }) => Promise<unknown>;

export const buildGuide = async (read: PullRequestForGuide, instructions: string, ask: AskModel): Promise<AssembledGuide> => {
    const answer = await ask(buildCloudGuidePrompt(promptInputOf(read, instructions)));

    return assembleGuide(read.files, answer, read.leftOut);
};

/**
 * A host agent's answer, checked as the cloud model's is. The agent read the head commit it was told to, so an answer is
 * only checked against the diff of that same commit: a pull request that has moved since is not guessed at.
 */
export const guideFromHostAnswer = (
    read: PullRequestForGuide,
    askedHeadSha: string,
    answerJson: string | null,
): { failure: "head_moved" | "no_answer" } | { guide: AssembledGuide } => {
    if (answerJson === null) {
        return { failure: "no_answer" };
    }

    if (read.headSha !== askedHeadSha) {
        return { failure: "head_moved" };
    }

    return { guide: assembleGuide(read.files, JSON.parse(answerJson) as unknown, read.leftOut) };
};
