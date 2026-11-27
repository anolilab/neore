import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { OWNER } from "./owner";
import { getActivePersona } from "../session";

/** A table id for a fixture row: ids are opaque strings to the app, branded only in types. */
const id = <T extends string>(value: string): Id<T> => value as unknown as Id<T>;

type HomeOverview = ReturnOf<typeof api.home.overview.getHomeOverview>;

/** The signed-in home: something waiting, something running, notifications and recent chats. */
export const homeOverview = (overrides: Partial<HomeOverview> = {}): HomeOverview => {
    return {
        approvals: [
            {
                approvalId: "approval_1",
                createdAt: ago(12 * MINUTE),
                threadId: "0193c1b2-7d1e-7a3c-9f00-000000000001",
                threadTitle: "Plan the Q1 product launch",
            },
        ],
        codingAgents: [
            {
                _id: "agent_1",
                agent: "claude_code",
                createdAt: ago(40 * MINUTE),
                prompt: "Fix the flaky checkout test",
                repo: "acme/storefront",
                status: "running",
            },
        ],
        dailyBriefEnabled: false,
        dailyBriefOffer: false,
        notifications: [
            { _id: "n1", createdAt: ago(HOUR), link: "/chat/t1", read: false, title: "Deploy the preview", type: "tool_approval" },
            { _id: "n2", body: "12 items summarised", createdAt: ago(5 * HOUR), outcome: "success", read: false, title: "Weekly report", type: "task" },
        ],
        recentThreads: [
            { _id: "0193c1b2-7d1e-7a3c-9f00-000000000001", title: "Plan the Q1 product launch", updatedAt: ago(20 * MINUTE) },
            { _id: "0193c1b2-7d1e-7a3c-9f00-000000000003", title: "Fix flaky Playwright test", updatedAt: ago(26 * HOUR) },
            { _id: "0193c1b2-7d1e-7a3c-9f00-000000000004", title: "Rust lifetimes, explained", updatedAt: ago(9 * DAY) },
        ],
        reviews: [{ _id: "task_review", title: "Summarise the support backlog", updatedAt: ago(3 * HOUR) }],
        runningTasks: [{ _id: "task_run", status: "running", title: "Compile the weekly metrics", updatedAt: ago(5 * MINUTE) }],
        subAgents: [],
        unreadCount: 2,
        userId: `user_${getActivePersona()}`,
        ...overrides,
    };
};

export const homeFixtures = (overview: Partial<HomeOverview> = {}): LunoraFixture[] => [
    // The overview is read for the persona the story shows, so the page offers nothing for another account's answer.
    lunora(api.home.overview.getHomeOverview, () => homeOverview({ ...overview })),
];

type SkillRow = Awaited<ReturnOf<typeof api.skills.functions.getSkills>>[number];

const skill = (overrides: Record<string, unknown> & { _id: string; name: string; slug: string }): SkillRow => {
    return {
        _creationTime: ago(3 * DAY),
        description: "",
        enabled: true,
        canEdit: true,
        instructions: "Follow the steps.",
        source: { type: "editor" },
        updatedAt: ago(DAY),
        userId: OWNER,
        ...overrides,
    } as unknown as SkillRow;
};

export const SKILLS: SkillRow[] = [
    skill({
        _id: "skill_1",
        category: "Writing",
        description: "Turn rough notes into a clear status update for the team, with next steps.",
        name: "Weekly update",
        slug: "weekly-update",
    }),
    skill({
        _id: "skill_2",
        category: "Code",
        config: { searchMode: "web" },
        description: "Review a diff for bugs, missing tests and unclear names, and answer with a short list.",
        enabled: false,
        name: "Code review",
        slug: "code-review",
        source: { repoUrl: "https://github.com/acme/skills", type: "github" },
    }),
    skill({
        _id: "skill_3",
        category: "Research",
        description: "Collect sources on a topic, compare what they claim and cite each one.",
        isInstalled: true,
        canEdit: false,
        name: "Literature scan",
        slug: "literature-scan",
        source: { originalSkillId: "skill_x", type: "official" },
        userId: "user_other",
        visibility: "public",
    }),
    skill({
        _id: "skill_4",
        description: "Draft release notes from merged pull requests.",
        name: "Release notes",
        slug: "release-notes",
        visibility: "organization",
    }),
    skill({
        _id: "skill_5",
        category: "Support",
        description: "Answer a customer email in a calm tone, following the refund policy.",
        name: "Support reply",
        slug: "support-reply",
        source: { filename: "support.md", type: "upload", uploadedAt: ago(8 * DAY) },
    }),
    skill({
        _id: "skill_6",
        category: "Writing",
        description: "Rewrite a paragraph for a different audience.",
        name: "Audience rewrite",
        slug: "audience-rewrite",
    }),
];

type MarketplaceSkill = ReturnOf<typeof api.skills.marketplace.browseSkills>["skills"][number];

const marketplaceSkill = (index: number, name: string, description: string, category: string, rating: number, usageCount: number): MarketplaceSkill => {
    return {
        _id: id<"skills">(`market_${String(index)}`),
        category,
        description,
        name,
        rating,
        ratingCount: 10 + index * 3,
        slug: name.toLowerCase().replaceAll(" ", "-"),
        tags: [category.toLowerCase()],
        usageCount,
    } as MarketplaceSkill;
};

export const MARKETPLACE: MarketplaceSkill[] = [
    marketplaceSkill(1, "Meeting minutes", "Turn a transcript into minutes with decisions and owners.", "Productivity", 4.6, 1840),
    marketplaceSkill(2, "SQL explainer", "Explain a query step by step and flag slow joins.", "Code", 4.4, 960),
    marketplaceSkill(3, "Brand voice check", "Compare a draft against your brand voice guide.", "Writing", 4.8, 720),
    marketplaceSkill(4, "Invoice parser", "Pull line items and totals out of an invoice PDF.", "Finance", 4.1, 410),
    marketplaceSkill(5, "Onboarding checklist", "Build a first-week plan for a new hire.", "People", 4.5, 330),
    marketplaceSkill(6, "Bug triage", "Group incoming bug reports and propose owners.", "Code", 4.3, 280),
];

/** The skills page with a populated list; `skills` empty gives the empty state. */
export const skillsFixtures = (options: { marketplace?: MarketplaceSkill[]; skills?: SkillRow[] } = {}): LunoraFixture[] => [
    lunora(api.skills.functions.getSkills, options.skills ?? SKILLS),
    lunora(api.skills.functions.getSkillCount, { canCreate: true, count: (options.skills ?? SKILLS).length, isPremium: true, limit: null }),
    lunora(api.skills.marketplace.browseSkills, { hasMore: false, skills: options.marketplace ?? MARKETPLACE }),
    lunora(api.skills.marketplace.searchSkills, []),
];

type PromptRow = Awaited<ReturnOf<typeof api.prompts.functions.getPrompts>>[number];

const prompt = (overrides: Record<string, unknown> & { _id: string; content: string; name: string }): PromptRow => {
    return { _creationTime: ago(5 * DAY), updatedAt: ago(DAY), userId: OWNER, ...overrides } as unknown as PromptRow;
};

export const PROMPTS: PromptRow[] = [
    prompt({
        _id: "prompt_1",
        content: "You are a careful editor. Rewrite {{text}} for {{audience}}, keeping every fact and cutting filler.",
        description: "Edit a draft for a given audience",
        isFavorite: true,
        name: "Careful editor",
        tags: ["writing", "editing"],
    }),
    prompt({
        _id: "prompt_2",
        content: "Act as a staff engineer reviewing a pull request. Point out risks first, then style.",
        description: "Pull request review stance",
        name: "Staff reviewer",
        tags: ["code"],
    }),
    prompt({ _id: "prompt_3", content: "Summarise the following in three bullets:\n{{input}}", isFavorite: true, name: "Three bullets", tags: ["summary"] }),
    prompt({
        _id: "prompt_4",
        content: "Explain it like I am new to the field, then give one example.",
        description: "Plain explanations",
        name: "Explain simply",
        tags: ["learning", "writing", "teaching", "kids"],
    }),
    prompt({ _id: "prompt_5", content: "Translate to {{language}} and keep the tone.", name: "Translate", tags: ["language"] }),
    prompt({
        _id: "prompt_6",
        content: "List the open questions in this thread and who should answer each.",
        description: "Find loose ends",
        name: "Loose ends",
    }),
];

export const promptsFixtures = (prompts: PromptRow[] = PROMPTS): LunoraFixture[] => [
    lunora(api.prompts.functions.getPrompts, prompts),
    lunora(api.prompts.functions.getPromptCount, { canCreate: true, count: prompts.length, isPremium: true, limit: null }),
    lunora(api.prompts.functions.getPromptTags, prompts.length > 0 ? ["writing", "code", "summary", "language", "learning"] : []),
];

type TaskBoard = ReturnOf<typeof api.tasks.functions.getTaskBoard>;

const task = (
    overrides: Record<string, unknown> & { _id: string; status: TaskBoard["tasks"][number]["status"]; title: string },
): TaskBoard["tasks"][number] => {
    return {
        attemptCount: 0,
        codingAgent: null,
        createdAt: ago(4 * DAY),
        cronExpression: null,
        dependsOn: [],
        goalId: null,
        instructions: "Do the work and report back.",
        lastError: null,
        lastRunNotice: null,
        lastRunThreadId: null,
        lastSkipReason: null,
        lastSkippedAt: null,
        maxRepairRounds: 2,
        model: null,
        nextRunAt: null,
        parentTaskId: null,
        projectId: null,
        reasoningEffort: null,
        resultSummary: null,
        reviewNote: null,
        runDestination: null,
        skillId: null,
        successCriteria: null,
        updatedAt: ago(HOUR),
        ...overrides,
    } as unknown as TaskBoard["tasks"][number];
};

export const TASK_BOARD: TaskBoard = {
    goals: [
        {
            _id: id<"goals">("goal_1"),
            createdAt: ago(6 * DAY),
            description: "Everything that has to land before the 12 November launch.",
            progress: { blocked: 0, done: 2, failed: 0, inProgress: 1, needsReview: 1, percent: 40, total: 5 },
            status: "active",
            successCriteria: "Pricing page live, support macros updated.",
            title: "Launch week",
            updatedAt: ago(HOUR),
        },
        {
            _id: id<"goals">("goal_2"),
            createdAt: ago(20 * DAY),
            description: null,
            progress: { blocked: 0, done: 4, failed: 0, inProgress: 0, needsReview: 0, percent: 100, total: 4 },
            status: "active",
            successCriteria: null,
            title: "Clean up the help centre",
            updatedAt: ago(3 * DAY),
        },
    ] as unknown as TaskBoard["goals"],
    tasks: [
        task({
            _id: "task_1",
            goalId: "goal_1",
            resultSummary: "Three open questions remain on the refund wording.",
            status: "needs_review",
            title: "Review the pricing page copy",
        }),
        task({ _id: "task_2", goalId: "goal_1", status: "running", title: "Compile the weekly metrics", attemptCount: 1 }),
        task({ _id: "task_3", status: "queued", title: "Archive last quarter's threads" }),
        task({ _id: "task_4", dependsOn: ["task_2"], status: "blocked", title: "Send the metrics digest" }),
        task({ _id: "task_5", cronExpression: "0 8 * * 1", status: "todo", title: "Monday planning brief" }),
        task({ _id: "task_6", lastError: "The connector returned 401 for the calendar.", status: "failed", title: "Sync the team calendar", attemptCount: 2 }),
        task({
            _id: "task_7",
            goalId: "goal_1",
            resultSummary: "Macros updated and linked from the help centre.",
            status: "done",
            title: "Update the support macros",
        }),
    ] as unknown as TaskBoard["tasks"],
};

export const tasksFixtures = (board: TaskBoard = TASK_BOARD): LunoraFixture[] => [
    lunora(api.tasks.functions.getTaskBoard, board),
    lunora(api.tasks.functions.listTaskSkillOptions, []),
    lunora(api.tasks.functions.getTaskRuns, []),
];

type VaultFile = ReturnOf<typeof api.vault.functions.getAttachmentsForUser>[number];

const file = (index: number, name: string, type: string, size: number): VaultFile => {
    return {
        _creationTime: ago(index * DAY),
        _id: id<"files">(`file_${String(index)}`),
        chatId: "0193c1b2-7d1e-7a3c-9f00-000000000001",
        fileName: name,
        fileSize: size,
        fileType: type,
        name,
        size,
        type,
        userId: OWNER,
    } as unknown as VaultFile;
};

export const VAULT_FILES: VaultFile[] = [
    file(1, "launch-plan.pdf", "application/pdf", 482_000),
    file(2, "pricing-table.xlsx", "application/vnd.ms-excel", 96_000),
    file(3, "interview-recording.mp3", "audio/mpeg", 8_400_000),
    file(4, "screenshots.zip", "application/zip", 3_200_000),
    file(5, "notes.txt", "text/plain", 4300),
    file(6, "demo.mp4", "video/mp4", 22_000_000),
];

export const vaultFixtures = (files: VaultFile[] = VAULT_FILES): LunoraFixture[] => [
    lunora(api.vault.functions.getAttachmentsForUser, files),
    lunora(api.vault.site_logins.listSiteLogins, {
        logins: [
            {
                hasPassword: true,
                id: id<"savedSiteLogins">("login_1"),
                label: "Billing console",
                signInUrl: "https://billing.example.com/login",
                site: "https://billing.example.com",
                teammateIds: [],
                updatedAt: ago(2 * DAY),
                username: "ops@example.com",
            },
            {
                hasPassword: true,
                id: id<"savedSiteLogins">("login_2"),
                site: "https://analytics.example.com",
                teammateIds: [],
                updatedAt: ago(9 * DAY),
                username: "dani",
            },
        ],
        userId: "user_pro",
    } as never),
    lunora(api.bots.functions.listBots, []),
];

type Dataset = ReturnOf<typeof api.evals.functions.listDatasets>[number];
type Run = ReturnOf<typeof api.evals.functions.listRuns>[number];
type DatasetDetail = ReturnOf<typeof api.evals.functions.getDataset>;

const DATASETS: Dataset[] = [
    {
        _id: id<"evalDatasets">("ds_1"),
        caseCount: 24,
        createdAt: ago(12 * DAY),
        description: "Answers checked against the refund policy.",
        judgeEnabled: true,
        kind: "agent",
        name: "Support answers",
        updatedAt: ago(2 * HOUR),
    },
    {
        _id: id<"evalDatasets">("ds_2"),
        caseCount: 40,
        createdAt: ago(30 * DAY),
        description: null,
        judgeEnabled: false,
        kind: "rag",
        name: "Product docs retrieval",
        updatedAt: ago(3 * DAY),
    },
];

const summary = (passed: number, total: number) => {
    return {
        avgContextPrecision: null,
        avgContextRecall: null,
        avgFaithfulness: null,
        avgJudgeScore: 0.82,
        avgLatencyMs: 1840,
        avgScore: 0.78,
        checkPassRate: 0.9,
        errored: 0,
        hitRate: null,
        mrr: null,
        passed,
        passRate: passed / total,
        scored: total,
        skipped: 0,
        total,
        totalCostMicrodollars: 42_000,
    };
};

const RUNS: Run[] = [
    {
        _id: id<"evalRuns">("run_1"),
        caseCount: 24,
        completedAt: ago(2 * HOUR),
        costCapMicrodollars: 1_000_000,
        costMicrodollars: 42_000,
        createdAt: ago(3 * HOUR),
        datasetId: DATASETS[0]!._id,
        error: null,
        label: "Sonnet 4.5 baseline",
        nextIndex: 24,
        status: "completed",
        summary: summary(21, 24),
        target: { kind: "model", model: "anthropic/claude-sonnet-4.5" },
        tokenBudget: 500_000,
        unpricedTokens: 0,
    },
    {
        _id: id<"evalRuns">("run_2"),
        caseCount: 24,
        completedAt: ago(DAY),
        costCapMicrodollars: 1_000_000,
        costMicrodollars: 31_000,
        createdAt: ago(DAY + HOUR),
        datasetId: DATASETS[0]!._id,
        error: null,
        label: null,
        nextIndex: 24,
        status: "completed",
        summary: summary(17, 24),
        target: { kind: "model", model: "google/gemini-2.5-flash" },
        tokenBudget: 500_000,
        unpricedTokens: 0,
    },
];

export const evalsFixtures = (datasets: Dataset[] = DATASETS): LunoraFixture[] => [
    lunora(api.evals.functions.listDatasets, datasets),
    lunora(api.evals.functions.getDataset, ({ datasetId }: { datasetId: unknown }): DatasetDetail => {
        const dataset = datasets.find((candidate) => candidate._id === datasetId) ?? datasets[0]!;

        return {
            cases: [
                {
                    _id: id<"evalCases">("case_1"),
                    checks: [{ kind: "contains", value: "30 days" }],
                    createdAt: ago(10 * DAY),
                    expectedAnswer: "Refunds are possible within 30 days of purchase.",
                    expectedSources: [],
                    frozen: false,
                    input: "Can I get a refund after three weeks?",
                    rubric: null,
                    source: "manual",
                    updatedAt: ago(10 * DAY),
                },
                {
                    _id: id<"evalCases">("case_2"),
                    checks: [],
                    createdAt: ago(9 * DAY),
                    expectedAnswer: null,
                    expectedSources: [],
                    frozen: true,
                    input: "My invoice shows the wrong VAT number. What do I do?",
                    rubric: "Names the billing portal and promises a corrected invoice.",
                    source: "chat",
                    updatedAt: ago(9 * DAY),
                },
            ],
            dataset,
        };
    }),
    lunora(api.evals.functions.listRuns, ({ datasetId }: { datasetId: unknown }) => (datasetId === DATASETS[0]!._id ? RUNS : [])),
    lunora(api.knowledge.functions.listFiles, [] as never),
];
