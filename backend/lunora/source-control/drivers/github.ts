/**
 * The GitHub driver: reads only. Every call goes through the `HostRequest` the
 * caller bound to `https://api.github.com`, so the token reaches nowhere else.
 *
 * Limits, from GitHub's REST documentation: a pull request lists at most 3000
 * files and 250 commits, 100 to a page; search answers at most 1000 results.
 */
import z from "zod/v4";

import type { HostCapabilityReport } from "../capabilities";
import type { HostDriver } from "../driver";
import { HostApiError } from "../origin-fetch";
import type { HostRequest } from "../origin-fetch";
import type {
    CheckRun,
    CheckState,
    CheckSummary,
    CommitPage,
    FilePage,
    FileStatus,
    InboxPage,
    InboxSection,
    PullRequestDetail,
    PullRequestFile,
    PullRequestRef,
    PullRequestSummary,
} from "../types";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";

/** Files GitHub lists for one pull request, whatever its size. */
export const GITHUB_FILE_LIMIT = 3000;
/** Commits GitHub lists for one pull request. */
export const GITHUB_COMMIT_LIMIT = 250;
export const GITHUB_PAGE_SIZE = 100;
const INBOX_PAGE_SIZE = 30;

/** GitHub search stops at 1000 results; ten pages of 30 stay inside that. */
export const GITHUB_INBOX_MAX_PAGE = 10;
const MAX_FILE_PAGE = Math.ceil(GITHUB_FILE_LIMIT / GITHUB_PAGE_SIZE);
const MAX_COMMIT_PAGE = Math.ceil(GITHUB_COMMIT_LIMIT / GITHUB_PAGE_SIZE);

/** Longest patch kept for one file, and for all the files of one page. */
export const PATCH_MAX_CHARS = 60_000;
export const PAGE_PATCH_BUDGET_CHARS = 600_000;
const BODY_MAX_CHARS = 60_000;
const RESPONSE_MAX_BYTES = 12_000_000;

const NATIVE = { degradation: "none", supported: true } as const;

export const GITHUB_CAPABILITIES: HostCapabilityReport = {
    groups: {
        inbox: {
            // Search `author:` with `draft:true`.
            drafts: NATIVE,
            mine: NATIVE,
            needsMyReview: NATIVE,
            // Branch protection and required checks are not evaluated: this is "approved and not a draft".
            readyToMerge: { degradation: "synthetic", note: "Approved and not a draft. Branch protection is not checked.", supported: true },
        },
        pullRequest: { checks: NATIVE, commits: NATIVE, description: NATIVE, diff: NATIVE, files: NATIVE },
    },
    reportedAt: 0,
    version: 1,
};

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const REPO = /^(?!\.{1,2}$)[\w.-]{1,100}$/u;
const SHA = /^[0-9a-f]{40,64}$/u;

/** `owner/name` split and checked: it becomes two URL path segments. */
export const splitGithubRepo = (repo: string): { name: string; owner: string } | undefined => {
    const [owner, name, ...extra] = repo.split("/");

    return extra.length === 0 && owner !== undefined && name !== undefined && OWNER.test(owner) && REPO.test(name) ? { name, owner } : undefined;
};

const repoPath = (ref: PullRequestRef): string => {
    const parts = splitGithubRepo(ref.repository);

    if (!parts || !Number.isSafeInteger(ref.number) || ref.number < 1) {
        throw new HostApiError("Not a GitHub pull request address", 404);
    }

    return `/repos/${parts.owner}/${parts.name}`;
};

/** Cancels a response body nobody will read; a failure to cancel is not worth reporting. */
const discard = async (response: Response): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
};

/** The body as text, read up to `RESPONSE_MAX_BYTES`: the cap bounds memory, not just what is kept. */
const readText = async (response: Response): Promise<string> => {
    const tooLarge = new HostApiError("The host's response is larger than this reads", 0);
    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
        await discard(response);

        throw tooLarge;
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (reader) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        received += value.byteLength;

        if (received > RESPONSE_MAX_BYTES) {
            await reader.cancel();

            throw tooLarge;
        }

        chunks.push(value);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(bytes);
};

const readJson = async (response: Response): Promise<unknown> => {
    const text = await readText(response);

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new HostApiError("The host's response was not JSON", 0);
    }
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);

    if (!result.success) {
        throw new HostApiError("The host's response did not have the expected shape", 0);
    }

    return result.data;
};

const toMs = (iso: string | null | undefined): number => {
    const ms = iso ? Date.parse(iso) : NaN;

    return Number.isNaN(ms) ? 0 : ms;
};

const webUrl = (url: string | null | undefined): string | null => (url?.startsWith(`${GITHUB_WEB_ORIGIN}/`) ? url : null);

/** A page number from a client: a whole number from 1 to `max`, whatever it sent. */
const clampPage = (page: number, max: number): number => (Number.isFinite(page) ? Math.min(Math.max(Math.trunc(page), 1), max) : 1);

const pageQuery = (page: number, maxPage: number): { page: number; per_page: number } => {
    return { page: clampPage(page, maxPage), per_page: GITHUB_PAGE_SIZE };
};

// ─── Inbox ──────────────────────────────────────────────────────────────────

const searchSchema = z.object({ items: z.array(z.unknown()), total_count: z.number() });

const searchItemSchema = z.object({
    comments: z.number().optional(),
    created_at: z.string(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    number: z.int(),
    repository_url: z.string(),
    title: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
});

const REPOSITORY_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/u;

const toSummary = (value: unknown): PullRequestSummary | undefined => {
    const item = searchItemSchema.safeParse(value);
    const repo = item.success ? REPOSITORY_URL.exec(item.data.repository_url)?.[1] : undefined;
    const url = item.success ? webUrl(item.data.html_url) : null;

    if (!item.success || repo === undefined || url === null) {
        return undefined;
    }

    return {
        authorLogin: item.data.user?.login ?? "ghost",
        commentCount: item.data.comments ?? 0,
        createdAt: toMs(item.data.created_at),
        draft: item.data.draft === true,
        labels: (item.data.labels ?? []).map((label) => label.name),
        number: item.data.number,
        repository: repo,
        title: item.data.title,
        updatedAt: toMs(item.data.updated_at),
        url,
    };
};

const SECTION_FILTERS: Record<InboxSection, (login: string) => string> = {
    drafts: (login) => `author:${login} draft:true`,
    mine: (login) => `author:${login}`,
    needsMyReview: (login) => `review-requested:${login} draft:false`,
    readyToMerge: (login) => `author:${login} review:approved draft:false`,
};

/** The search qualifiers of one section, for the signed-in `login`. */
export const inboxQuery = (section: InboxSection, login: string): string => `is:pr is:open archived:false ${SECTION_FILTERS[section](login)}`;

const logins = new WeakMap<HostRequest, Promise<string>>();

/**
 * The signed-in login, read once per requester (one per action), since `@me` is not
 * documented for the REST search. A failed read is not kept, so a retry asks again.
 */
const signedInLogin = (request: HostRequest): Promise<string> => {
    const known = logins.get(request);

    if (known) {
        return known;
    }

    const read = (async () => {
        const user = parse(z.object({ login: z.string() }), await readJson(await request("/user")));

        return user.login;
    })();

    logins.set(request, read);
    read.catch(() => logins.delete(request));

    return read;
};

const listInbox = async (request: HostRequest, section: InboxSection, page: number): Promise<InboxPage> => {
    const current = clampPage(page, GITHUB_INBOX_MAX_PAGE);
    const login = await signedInLogin(request);
    const search = parse(
        searchSchema,
        await readJson(
            await request("/search/issues", {
                query: { order: "desc", page: current, per_page: INBOX_PAGE_SIZE, q: inboxQuery(section, login), sort: "updated" },
            }),
        ),
    );
    const reachable = Math.min(search.total_count, 1000);

    return {
        hasMore: current < GITHUB_INBOX_MAX_PAGE && current * INBOX_PAGE_SIZE < reachable,
        items: search.items.map((item) => toSummary(item)).filter((item): item is PullRequestSummary => item !== undefined),
        page: current,
        total: search.total_count,
    };
};

// ─── One pull request ───────────────────────────────────────────────────────

const pullSchema = z.object({
    additions: z.number(),
    base: z.object({ ref: z.string() }),
    body: z.string().nullable(),
    changed_files: z.number(),
    commits: z.number(),
    created_at: z.string(),
    deletions: z.number(),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    html_url: z.string(),
    merged: z.boolean().optional(),
    number: z.int(),
    state: z.string(),
    title: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
});

const pullState = (pull: { merged?: boolean; state: string }): PullRequestDetail["state"] => {
    if (pull.merged === true) {
        return "merged";
    }

    return pull.state === "closed" ? "closed" : "open";
};

const getPullRequest = async (request: HostRequest, ref: PullRequestRef): Promise<PullRequestDetail> => {
    const pull = parse(pullSchema, await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}`)));
    const body = pull.body ?? "";

    return {
        additions: pull.additions,
        authorLogin: pull.user?.login ?? "ghost",
        baseBranch: pull.base.ref,
        body: body.slice(0, BODY_MAX_CHARS),
        bodyTruncated: body.length > BODY_MAX_CHARS,
        changedFiles: pull.changed_files,
        commitCount: pull.commits,
        createdAt: toMs(pull.created_at),
        deletions: pull.deletions,
        draft: pull.draft === true,
        headBranch: pull.head.ref,
        headSha: pull.head.sha,
        number: pull.number,
        repository: ref.repository,
        state: pullState(pull),
        title: pull.title,
        updatedAt: toMs(pull.updated_at),
        url: webUrl(pull.html_url) ?? `${GITHUB_WEB_ORIGIN}/${ref.repository}/pull/${ref.number}`,
    };
};

const commitSchema = z.object({
    commit: z.object({ author: z.object({ date: z.string().optional(), name: z.string().optional() }).nullable(), message: z.string() }),
    sha: z.string(),
});

const listCommits = async (request: HostRequest, ref: PullRequestRef, page: number): Promise<CommitPage> => {
    const { page: current, per_page: perPage } = pageQuery(page, MAX_COMMIT_PAGE);
    const items = parse(
        z.array(z.unknown()),
        await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}/commits`, { query: { page: current, per_page: perPage } })),
    );
    const commits = items.flatMap((item) => {
        const parsed = commitSchema.safeParse(item);

        return parsed.success
            ? [
                  {
                      authorName: parsed.data.commit.author?.name ?? "",
                      committedAt: toMs(parsed.data.commit.author?.date),
                      message: parsed.data.commit.message,
                      sha: parsed.data.sha,
                  },
              ]
            : [];
    });

    return { commits, hasMore: items.length === perPage && current < MAX_COMMIT_PAGE, page: current };
};

const FILE_STATUSES = new Set<string>(["added", "changed", "copied", "modified", "removed", "renamed", "unchanged"]);

const fileSchema = z.object({
    additions: z.number(),
    deletions: z.number(),
    filename: z.string(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
    status: z.string(),
});

/** Keeps each file's patch within its own ceiling and the page within one budget, in the host's order. */
const fitPatches = (files: PullRequestFile[]): PullRequestFile[] => {
    let remaining = PAGE_PATCH_BUDGET_CHARS;

    return files.map((file) => {
        if (file.patch === null) {
            return file;
        }

        const allowed = Math.min(PATCH_MAX_CHARS, remaining);

        if (file.patch.length <= allowed) {
            remaining -= file.patch.length;

            return file;
        }

        if (allowed === 0) {
            return { ...file, patch: null, patchState: "over_budget" as const };
        }

        remaining -= allowed;

        return { ...file, patch: file.patch.slice(0, allowed), patchState: "truncated" as const };
    });
};

const toFile = (value: unknown): PullRequestFile | undefined => {
    const parsed = fileSchema.safeParse(value);

    if (!parsed.success) {
        return undefined;
    }

    const { data } = parsed;

    return {
        additions: data.additions,
        deletions: data.deletions,
        patch: data.patch ?? null,
        patchState: data.patch === undefined ? "host_omitted" : "full",
        path: data.filename,
        previousPath: data.previous_filename ?? null,
        status: (FILE_STATUSES.has(data.status) ? data.status : "changed") as FileStatus,
    };
};

const listFiles = async (request: HostRequest, ref: PullRequestRef, page: number): Promise<FilePage> => {
    const { page: current, per_page: perPage } = pageQuery(page, MAX_FILE_PAGE);
    const items = parse(
        z.array(z.unknown()),
        await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}/files`, { query: { page: current, per_page: perPage } })),
    );
    const files = items.map((item) => toFile(item)).filter((file): file is PullRequestFile => file !== undefined);

    return { files: fitPatches(files), hasMore: items.length === perPage && current < MAX_FILE_PAGE, page: current };
};

// ─── Checks ─────────────────────────────────────────────────────────────────

const checkRunsSchema = z.object({
    check_runs: z.array(z.unknown()),
    total_count: z.number(),
});

const checkRunSchema = z.object({
    conclusion: z.string().nullable(),
    html_url: z.string().nullable().optional(),
    name: z.string(),
    status: z.string(),
});

const commitStatusSchema = z.object({
    statuses: z.array(z.unknown()),
    total_count: z.number().optional(),
});

const statusSchema = z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable().optional() });

const CONCLUSIONS: Record<string, CheckState> = {
    action_required: "failure",
    cancelled: "cancelled",
    failure: "failure",
    neutral: "neutral",
    skipped: "skipped",
    stale: "neutral",
    startup_failure: "failure",
    success: "success",
    timed_out: "failure",
};

const runState = (status: string, conclusion: string | null): CheckState =>
    status === "completed" && conclusion !== null ? (CONCLUSIONS[conclusion] ?? "neutral") : "pending";

const STATUS_STATES: Record<string, CheckState> = { error: "failure", failure: "failure", success: "success" };

const statusState = (state: string): CheckState => STATUS_STATES[state] ?? "pending";

const listChecks = async (request: HostRequest, ref: PullRequestRef, headSha: string): Promise<CheckSummary> => {
    if (!SHA.test(headSha)) {
        throw new HostApiError("Not a commit id", 404);
    }

    const base = `${repoPath(ref)}/commits/${headSha}`;
    const settled = await Promise.allSettled([
        request(`${base}/check-runs`, { query: { per_page: GITHUB_PAGE_SIZE } }),
        request(`${base}/status`, { query: { per_page: GITHUB_PAGE_SIZE } }),
    ]);
    const rejected = settled.find((outcome) => outcome.status === "rejected");

    if (rejected) {
        // The other request may have succeeded: its body is still open and nobody will read it.
        await Promise.all(settled.map(async (outcome) => (outcome.status === "fulfilled" ? await discard(outcome.value) : undefined)));

        throw rejected.reason;
    }

    const [runsResponse, statusResponse] = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));

    if (!runsResponse || !statusResponse) {
        throw new HostApiError("The host did not answer", 0);
    }

    let runs: z.infer<typeof checkRunsSchema>;

    try {
        runs = parse(checkRunsSchema, await readJson(runsResponse));
    } catch (error) {
        await discard(statusResponse);

        throw error;
    }

    const statuses = parse(commitStatusSchema, await readJson(statusResponse));
    const checks: CheckRun[] = [
        ...runs.check_runs.flatMap((value) => {
            const run = checkRunSchema.safeParse(value);

            return run.success ? [{ name: run.data.name, state: runState(run.data.status, run.data.conclusion), url: webUrl(run.data.html_url) }] : [];
        }),
        ...statuses.statuses.flatMap((value) => {
            const status = statusSchema.safeParse(value);

            // A status's link is the CI system's own, not a GitHub address: it is not kept.
            return status.success ? [{ name: status.data.context, state: statusState(status.data.state), url: null }] : [];
        }),
    ];

    return { checks, total: runs.total_count + (statuses.total_count ?? statuses.statuses.length) };
};

export const githubDriver: HostDriver = {
    apiOrigin: GITHUB_API_ORIGIN,
    getPullRequest,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "neore-chat", "X-GitHub-Api-Version": "2022-11-28" },
    kind: "github",
    listChecks,
    listCommits,
    listFiles,
    listInbox,
    view: {
        capabilities: GITHUB_CAPABILITIES,
        connectorSlug: "github",
        label: "GitHub",
        limits: { commits: GITHUB_COMMIT_LIMIT, files: GITHUB_FILE_LIMIT },
        requestNoun: "pull request",
    },
    webOrigin: GITHUB_WEB_ORIGIN,
};
