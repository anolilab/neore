import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";

const id = <T extends string>(value: string): Id<T> => value as unknown as Id<T>;

const supported = { degradation: "none", supported: true } as const;

/** What a Git host reports when it offers the inbox, the description, commits, files and checks, but no writes. */
const HOST = {
    capabilities: {
        groups: {
            inbox: { drafts: supported, mine: supported, needsMyReview: supported, readyToMerge: supported },
            pullRequest: { checks: supported, commits: supported, description: supported, files: supported },
        },
        reportedAt: ago(HOUR),
        version: 1,
    },
    connectorSlug: "github",
    label: "GitHub",
    limits: { commits: 250, files: 300, reviewers: 15 },
    requestNoun: "pull request",
} as const;

type Inbox = ReturnOf<typeof api.source_control.functions.getInbox>;
type InboxItem = Extract<Inbox, { status: "ok" }>["items"][number];

const item = (number: number, title: string, author: string, repository: string, age: number, draft = false): InboxItem => {
    return {
        authorLogin: author,
        commentCount: number % 4,
        createdAt: ago(age + DAY),
        draft,
        labels: [],
        number,
        repository,
        title,
        updatedAt: ago(age),
        url: `https://github.com/${repository}/pull/${String(number)}`,
    };
};

const INBOX_ITEMS: InboxItem[] = [
    item(482, "Cache thread titles by owner so the sidebar stops refetching", "ada", "acme/storefront", 2 * HOUR),
    item(479, "Fix off-by-one in the pagination cursor", "grace", "acme/storefront", 6 * HOUR),
    item(471, "Draft: migrate the billing webhooks to the queue", "linus", "acme/billing", DAY, true),
    item(466, "Replace the hand-rolled retry with the shared helper", "ada", "acme/billing", 3 * DAY),
];

export const developFixtures = (options: { connected?: boolean; items?: InboxItem[] } = {}): LunoraFixture[] => [
    lunora(api.source_control.functions.getDevelopHost, { connected: options.connected ?? true, host: HOST } as never),
    lunora(api.source_control.pr_threads.listForPullRequest, []),
    lunora(api.source_control.review_drafts.getReviewDraft, null),
    lunora(api.source_control.functions.getInbox, {
        hasMore: false,
        items: options.items ?? INBOX_ITEMS,
        page: 1,
        status: "ok",
        total: (options.items ?? INBOX_ITEMS).length,
    }),
    lunora(api.source_control.functions.getPullRequest, {
        detail: {
            additions: 214,
            authorLogin: "ada",
            baseBranch: "main",
            body: "Thread titles were read once per row. This reads them once per owner and shares the result across the list.\n\n- adds a per-owner cache\n- drops the duplicate query in the header",
            bodyTruncated: false,
            changedFiles: 9,
            commitCount: 3,
            createdAt: ago(DAY),
            deletions: 58,
            draft: false,
            headBranch: "ada/thread-title-cache",
            headInBaseRepository: true,
            headSha: "9f2c1d7e4b6a8c0d1e2f3a4b5c6d7e8f9a0b1c2d",
            mergeState: "clean",
            number: 482,
            repository: "acme/storefront",
            state: "open",
            title: "Cache thread titles by owner so the sidebar stops refetching",
            updatedAt: ago(2 * HOUR),
            url: "https://github.com/acme/storefront/pull/482",
        },
        leftOut: { commits: 0, files: 0 },
        status: "ok",
    }),
];

type PageTree = ReturnOf<typeof api.pages.functions.listPageTree>;

export const PAGE_TREE: PageTree = {
    owned: [
        { _id: id<"pages">("page_1"), icon: null, isFavorite: true, isPublic: false, order: 0, parentPageId: null, title: "Launch plan", updatedAt: ago(HOUR) },
        {
            _id: id<"pages">("page_2"),
            icon: null,
            isFavorite: false,
            isPublic: false,
            order: 1,
            parentPageId: id<"pages">("page_1"),
            title: "Pricing page copy",
            updatedAt: ago(DAY),
        },
        {
            _id: id<"pages">("page_3"),
            icon: null,
            isFavorite: false,
            isPublic: true,
            order: 2,
            parentPageId: id<"pages">("page_1"),
            title: "Support macros",
            updatedAt: ago(2 * DAY),
        },
        {
            _id: id<"pages">("page_4"),
            icon: null,
            isFavorite: true,
            isPublic: false,
            order: 3,
            parentPageId: null,
            title: "Weekly notes",
            updatedAt: ago(3 * DAY),
        },
        {
            _id: id<"pages">("page_5"),
            icon: null,
            isFavorite: false,
            isPublic: false,
            order: 4,
            parentPageId: null,
            title: "Interview questions",
            updatedAt: ago(9 * DAY),
        },
    ],
    shared: [{ _id: id<"pages">("page_6"), icon: null, isFavorite: false, permission: "write", title: "Team handbook", updatedAt: ago(5 * DAY) }],
};

export const pagesFixtures = (tree: PageTree = PAGE_TREE): LunoraFixture[] => [
    lunora(api.pages.functions.listPageTree, tree),
    lunora(api.pages.functions.searchPages, []),
];

const workflow = (index: number, title: string, description: string, nodes: number, color: string): Record<string, unknown> => {
    return {
        _creationTime: ago(index * DAY),
        _id: `workflow_${String(index)}`,
        color,
        description,
        projectType: "workflow",
        title,
        workflowContent: { edges: [], nodes: Array.from({ length: nodes }, (_, node) => ({ id: `node_${String(node)}` })) },
    };
};

export const WORKFLOWS = [
    workflow(1, "Product photo set", "Generate five angles of a product from one reference image.", 7, "#8b5cf6"),
    workflow(2, "Weekly digest", "Pull the week's threads, summarise them and email the result.", 5, "#10b981"),
    workflow(3, "Blog to video", "Turn a post into a short narrated clip with captions.", 11, "#f59e0b"),
    workflow(4, "Untitled Workflow", "", 0, "#64748b"),
];

type GalleryWorkflow = Record<string, unknown>;

const galleryWorkflow = (
    index: number,
    title: string,
    description: string,
    category: string,
    forks: number,
    views: number,
    featured = false,
): GalleryWorkflow => {
    return {
        _id: `gallery_${String(index)}`,
        color: ["#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#3b82f6"][index % 5],
        description,
        galleryCategory: category,
        galleryFeatured: featured,
        galleryForkCount: forks,
        galleryPublishedAt: ago(index * DAY),
        galleryTags: [category, "starter"],
        galleryViewCount: views,
        nodeCount: 4 + index,
        publicAccessToken: `token_${String(index)}`,
        title,
    };
};

export const GALLERY = [
    galleryWorkflow(1, "Storyboard to clip", "Draft a storyboard, render each frame and stitch them into a clip.", "video", 320, 4200, true),
    galleryWorkflow(2, "Meeting notes to tasks", "Summarise a transcript and open a task per decision.", "automation", 540, 9100, true),
    galleryWorkflow(3, "Poster variations", "Explore ten takes on a poster from one prompt.", "image", 210, 3100),
    galleryWorkflow(4, "Podcast cleanup", "Remove filler words and normalise the levels.", "audio", 88, 1300),
    galleryWorkflow(5, "Translate and proofread", "Translate a document, then proofread it in the target language.", "text", 150, 2200),
    galleryWorkflow(6, "Daily competitor scan", "Collect competitor news each morning and mail a digest.", "automation", 64, 980),
];

export const workflowFixtures = (options: { gallery?: GalleryWorkflow[]; workflows?: Record<string, unknown>[] } = {}): LunoraFixture[] => [
    lunora(api.workflow.functions.listWorkflows, { continueCursor: "", isDone: true, page: options.workflows ?? WORKFLOWS } as never),
    lunora(api.workflow.gallery.browseGallery, { nextCursor: null, page: options.gallery ?? GALLERY }),
    lunora(api.workflow.gallery.getFeaturedWorkflows, (options.gallery ?? GALLERY).filter((entry) => entry["galleryFeatured"]) as never),
];

type Devices = ReturnOf<typeof api.devices.functions.listDevices>;

/** The Code page: the paired computers, and whether the account has connected a Git host (the last setup step). */
export const codeFixtures = (devices: Devices = [] as Devices, options: { gitConnected?: boolean } = {}): LunoraFixture[] => [
    lunora(api.devices.functions.listDevices, devices),
    lunora(api.source_control.functions.getDevelopHost, { connected: options.gitConnected ?? false, host: HOST } as never),
];

export const DEVICES = [
    {
        _id: "device_1",
        createdAt: ago(30 * DAY),
        lastSeenAt: ago(MINUTE),
        name: "Studio MacBook",
        platform: "darwin",
        toolNames: ["bash", "read"],
        updateRequired: false,
    },
    {
        _id: "device_2",
        createdAt: ago(60 * DAY),
        lastSeenAt: ago(3 * DAY),
        name: "Nova (Linux)",
        platform: "linux",
        toolNames: ["bash"],
        updateRequired: false,
    },
] as Devices;

/** A computer that has an approved coding agent for a folder: the "install a coding agent" step is done. */
export const DEVICES_WITH_AGENT = [
    {
        ...DEVICES[0],
        acpOffers: [{ agentKey: "claude", agentLabel: "Claude Code", folderId: "folder_1", folderLabel: "storefront" }],
    },
    DEVICES[1],
] as Devices;
