import { i18n } from "@lingui/core";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { Route as ShortcutRoute } from "@/routes/_shortcut";
import { Route as DevelopRoute } from "@/routes/_shortcut/develop";
import { chatFixtures } from "@/storybook/fixtures/chat";
import type { DevelopReviewOptions } from "@/storybook/fixtures/develop-review";
import { CHECKS_EMPTY, COMMITS, developReviewFixtures, DRAFT, GUIDE, HEAD_SHA, MERGE_BLOCKED } from "@/storybook/fixtures/develop-review";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import type { LunoraFixture } from "@/storybook/lunora";
import { lunora, lunoraHandlers, lunoraIdle, lunoraPending } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// A pull request loads its page, then each tab reads its own data from the host; with four browser projects at once that can outlast a few seconds.
const PAGE_WAIT = { timeout: 15_000 } as const;

const handlers = (options: DevelopReviewOptions = {}, ...overrides: LunoraFixture[]) => {
    return {
        gateway: gatewayModelsHandler(),
        lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures(), ...developReviewFixtures(options), ...overrides),
    };
};

/**
 * The Develop page with one pull request selected, one story per tab and state: the files with a diff open, a review
 * thread and a pending comment in it, checks with a failure, commits, the guide, and the merge panel.
 */
const meta = {
    args: { levels: [], url: "/develop" },
    // The checks and the file notes word their counts with the core `plural` macro, which reads the GLOBAL Lingui instance;
    // the story providers activate their own. Until they also activate this one, the page activates it here.
    beforeEach: async () => {
        // The same per-locale catalog import as `loadStoryLocale` (`storybook/providers.tsx`).
        const locale = "en";
        const { messages } = (await import(`../../locales/${locale}/messages.po`)) as { messages: Record<string, string> };

        i18n.loadAndActivate({ locale, messages });
    },
    component: StoryPage,
    parameters: { layout: "fullscreen", msw: { handlers: handlers() } },
    title: "Pages/Develop tabs",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

type Canvas = Parameters<NonNullable<Story["play"]>>[0]["canvas"];

const SHORTCUT = { id: "/_shortcut", route: ShortcutRoute } as const;

const LEVELS = [SHORTCUT, { path: "develop", route: DevelopRoute }];

const at = (tab: string) => `/develop?repository=acme%2Fstorefront&number=482&tab=${tab}`;

/** The merge, actions and review panels sit above the tabs: bring the pull request's tab strip (not the inbox's) to the top, so the tab is what a screenshot shows. */
const showTabs = async (canvas: Canvas) => {
    const tabs = await canvas.findByRole("tablist", { name: /views$/ }, PAGE_WAIT);

    // The panels above the strip load after it: scrolling first would leave the strip pushed back below the fold.
    await lunoraIdle();
    await new Promise((resolve) => {
        setTimeout(resolve, 400);
    });
    tabs.scrollIntoView({ block: "start" });
};

const FILE_ROW = { name: /src\/lib\/thread-titles\.ts/ } as const;

export const FilesList: Story = {
    args: { levels: LEVELS, url: at("files") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", FILE_ROW, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const FilesDiffOpen: Story = {
    args: { levels: LEVELS, url: at("files") },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", FILE_ROW, PAGE_WAIT));
        await expect(await canvas.findByText("const hit = cache.get(key);", { exact: false }, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const FilesReviewThread: Story = {
    args: { levels: LEVELS, url: at("files") },
    parameters: { msw: { handlers: handlers({ draft: DRAFT }) } },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", FILE_ROW, PAGE_WAIT));
        await expect(await canvas.findByText(/Does this need an eviction/, undefined, PAGE_WAIT)).toBeVisible();
        await expect(await canvas.findByText(/Add a test where two owners share a thread id/, undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const FilesComposer: Story = {
    args: { levels: LEVELS, url: at("files") },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", FILE_ROW, PAGE_WAIT));
        await userEvent.click(await canvas.findByRole("button", { name: "Comment on line 18" }, PAGE_WAIT));
        await expect(await canvas.findByRole("textbox", { name: "Comment on line 18" })).toBeVisible();
        await showTabs(canvas);
    },
};

export const FilesLoading: Story = {
    args: { levels: LEVELS, url: at("files") },
    parameters: { msw: { handlers: handlers({}, lunoraPending(api.source_control.functions.getPullRequestFiles)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status", { name: "Loading files" }, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const FilesRateLimited: Story = {
    args: { levels: LEVELS, url: at("files") },
    parameters: { msw: { handlers: handlers({}, lunora(api.source_control.functions.getPullRequestFiles, { status: "rate_limited" } as never)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Try again" }, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const ChecksWithFailure: Story = {
    args: { levels: LEVELS, url: at("checks") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("unit tests (ubuntu)", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const ChecksEmpty: Story = {
    args: { levels: LEVELS, url: at("checks") },
    parameters: { msw: { handlers: handlers({ checks: CHECKS_EMPTY }) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No checks have run for this commit.", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const ChecksUnavailable: Story = {
    args: { levels: LEVELS, url: at("checks") },
    parameters: { msw: { handlers: handlers({}, lunora(api.source_control.functions.getPullRequestChecks, { status: "forbidden" } as never)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("No access", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const Commits: Story = {
    args: { levels: LEVELS, url: at("commits") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Cap the title cache at 500 entries", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const CommitsLoading: Story = {
    args: { levels: LEVELS, url: at("commits") },
    parameters: { msw: { handlers: handlers({}, lunoraPending(api.source_control.functions.getPullRequestCommits)) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("status", { name: "Loading commits" }, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const CommitsFailed: Story = {
    args: { levels: LEVELS, url: at("commits") },
    parameters: {
        msw: { handlers: handlers({ commits: COMMITS }, lunora(api.source_control.functions.getPullRequestCommits, { status: "host_error" } as never)) },
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Could not load this", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const Guide: Story = {
    args: { levels: LEVELS, url: at("guide") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Per-owner title cache", undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const GuideNotWrittenYet: Story = {
    args: { levels: LEVELS, url: at("guide") },
    parameters: { msw: { handlers: handlers({ guide: null }) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Write the guide" }, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const GuideStale: Story = {
    args: { levels: LEVELS, url: at("guide") },
    parameters: { msw: { handlers: handlers({ guide: { ...GUIDE, freshness: "stale", guide: { ...GUIDE.guide, headSha: "0".repeat(40) } } }) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText(/written for an earlier commit/, undefined, PAGE_WAIT)).toBeVisible();
        await showTabs(canvas);
    },
};

export const MergeReady: Story = {
    args: { levels: LEVELS, url: at("description") },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Squash and merge" }, PAGE_WAIT)).toBeVisible();
    },
};

export const MergeConfirm: Story = {
    args: { levels: LEVELS, url: at("description") },
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: "Squash and merge" }, PAGE_WAIT));
        // The dialog is portalled out of the canvas.
        const note = await screen.findByText(`This merges the commit ${HEAD_SHA.slice(0, 7)}`, { exact: false }, PAGE_WAIT);

        // The dialog fades (on a phone, slides) in: wait for the end of it rather than judging its first frame.
        await waitFor(() => expect(note).toBeVisible(), PAGE_WAIT);
    },
};

export const MergeBlockedAutoOn: Story = {
    args: { levels: LEVELS, url: at("description") },
    parameters: { msw: { handlers: handlers({ merge: MERGE_BLOCKED }) } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Turn off auto-merge" }, PAGE_WAIT)).toBeVisible();
    },
};
