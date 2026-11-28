import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";

const id = <T extends string>(value: string): Id<T> => value as unknown as Id<T>;

export const DOCUMENT_ID = "page_2";

type PageDetail = ReturnOf<typeof api.pages.functions.getPage>;
type Threads = ReturnOf<typeof api.pages.comments.listPageComments>;
type Versions = ReturnOf<typeof api.pages.functions.listPageVersions>;
type Sharing = ReturnOf<typeof api.pages.sharing.getPageSharing>;
type Presence = ReturnOf<typeof api.pages.presence.listPagePresence>;

const text = (value: string, marks?: { attrs: { commentId: string }; type: string }[]) => {
    return { text: value, type: "text", ...(marks && { marks }) };
};

const paragraph = (...content: ReturnType<typeof text>[]) => {
    return { content, type: "paragraph" };
};

const heading = (level: number, value: string) => {
    return { attrs: { level }, content: [text(value)], type: "heading" };
};

const bullets = (...items: string[]) => {
    return { content: items.map((item) => ({ content: [paragraph(text(item))], type: "listItem" })), type: "bulletList" };
};

const COMMENT_ID = "comment_pricing";

const CONTENT_JSON = {
    content: [
        heading(2, "Why a new pricing page"),
        paragraph(
            text("The current page lists every plan in one table, so visitors compare the wrong things. "),
            text("The new page leads with what each plan is for", [{ attrs: { commentId: COMMENT_ID }, type: "comment" }]),
            text(" and moves the feature grid below the fold."),
        ),
        heading(2, "What changes"),
        bullets(
            "One headline per plan, written as a job to be done",
            "A single call to action per plan",
            "The comparison table moves to a collapsible section",
        ),
        heading(2, "Open questions"),
        paragraph(text("Do we show annual prices first? Support wants the monthly price visible without a click.")),
    ],
    type: "doc",
};

const CONTENT_MARKDOWN = [
    "## Why a new pricing page",
    "",
    "The current page lists every plan in one table, so visitors compare the wrong things. The new page leads with what each plan is for and moves the feature grid below the fold.",
    "",
    "## What changes",
    "",
    "- One headline per plan, written as a job to be done",
    "- A single call to action per plan",
    "- The comparison table moves to a collapsible section",
    "",
    "## Open questions",
    "",
    "Do we show annual prices first? Support wants the monthly price visible without a click.",
].join("\n");

const detail = (overrides: Partial<PageDetail> = {}): PageDetail => {
    return {
        _id: id<"pages">(DOCUMENT_ID),
        breadcrumbs: [{ _id: id<"pages">("page_1"), title: "Launch plan" }],
        content: CONTENT_MARKDOWN,
        contentJson: CONTENT_JSON,
        icon: null,
        isFavorite: false,
        isOwner: true,
        isPublic: false,
        permission: "admin",
        revision: 7,
        title: "Pricing page copy",
        updatedAt: ago(DAY),
        ...overrides,
    };
};

/** A page with nothing in it yet: what "New page" opens. */
export const EMPTY_DOCUMENT = detail({ breadcrumbs: [], content: null, contentJson: undefined, revision: 0, title: "", updatedAt: ago(MINUTE) });

const THREADS: Threads = [
    {
        _id: id<"pageComments">("pc_1"),
        anchorText: "The new page leads with what each plan is for",
        authorName: "Mara Lindqvist",
        body: "Can we test this headline against the old one before we commit to it?",
        commentId: COMMENT_ID,
        createdAt: ago(3 * HOUR),
        editedAt: null,
        isOwn: false,
        orphaned: false,
        replies: [
            {
                _id: id<"pageComments">("pc_1a"),
                authorName: "You",
                body: "Yes, the A/B slot opens on the 12th.",
                createdAt: ago(2 * HOUR),
                editedAt: null,
                isOwn: true,
            },
        ],
        resolvedAt: null,
        status: "open",
    },
    {
        _id: id<"pageComments">("pc_2"),
        anchorText: "Do we show annual prices first?",
        authorName: "Jonas Weber",
        body: "Annual first, with the monthly price in the toggle.",
        commentId: "comment_annual",
        createdAt: ago(DAY),
        editedAt: null,
        isOwn: false,
        orphaned: true,
        replies: [],
        resolvedAt: null,
        status: "open",
    },
];

const VERSIONS: Versions = [
    { _id: id<"pageVersions">("pv_1"), createdAt: ago(40 * MINUTE), isOwnEdit: true, reason: "edit", title: "Pricing page copy", updatedAt: ago(20 * MINUTE) },
    { _id: id<"pageVersions">("pv_2"), createdAt: ago(3 * HOUR), isOwnEdit: false, reason: "edit", title: "Pricing page copy", updatedAt: ago(3 * HOUR) },
    { _id: id<"pageVersions">("pv_3"), createdAt: ago(5 * HOUR), isOwnEdit: true, reason: "agent", title: "Pricing page copy", updatedAt: ago(5 * HOUR) },
    { _id: id<"pageVersions">("pv_4"), createdAt: ago(DAY + HOUR), isOwnEdit: true, reason: "restore", title: "Pricing page copy", updatedAt: ago(DAY + HOUR) },
    { _id: id<"pageVersions">("pv_5"), createdAt: ago(3 * DAY), isOwnEdit: true, reason: "edit", title: "Pricing", updatedAt: ago(3 * DAY - HOUR) },
];

const SHARING: Sharing = {
    grants: [
        { email: "mara@example.com", grantedAt: ago(4 * DAY), name: "Mara Lindqvist", permission: "write", userId: "user_mara" },
        { email: "jonas@example.com", grantedAt: ago(2 * DAY), name: "Jonas Weber", permission: "comment", userId: "user_jonas" },
    ],
    invites: [{ _id: id<"pageInvites">("pi_1"), createdAt: ago(HOUR), expiresAt: ago(-6 * DAY), permission: "read" }],
    isPublic: true,
    publicAccessToken: "pg_4f9a2c7e",
};

export interface DocumentOptions {
    /** What `getPage` answers; `EMPTY_DOCUMENT` for a new page. */
    page?: PageDetail;
    /** Other people on the page; an editing one shows the soft-lock note. */
    presence?: Presence;
    sharing?: Sharing;
    threads?: Threads;
    versions?: Versions;
}

/**
 * One document open in the editor: the page, its comment threads, version history, sharing and presence, beside the
 * pages tree (`pagesFixtures`) the layout shows. Version bodies for the "compare" view are the page itself.
 */
export const documentFixtures = (options: DocumentOptions = {}): LunoraFixture[] => {
    const page = options.page ?? detail();

    return [
        lunora(api.pages.sharing.resolvePageShard, null),
        lunora(api.pages.functions.getPage, page),
        lunora(api.pages.comments.listPageComments, options.threads ?? THREADS),
        lunora(api.pages.functions.listPageVersions, options.versions ?? VERSIONS),
        lunora(api.pages.functions.getPageVersion, (args) => {
            return { _id: args.versionId, contentJson: CONTENT_JSON, createdAt: ago(3 * HOUR), title: "Pricing page copy" };
        }),
        lunora(api.pages.sharing.getPageSharing, options.sharing ?? SHARING),
        lunora(api.pages.presence.listPagePresence, options.presence ?? []),
        lunora(api.pages.presence.heartbeatPagePresence, null),
        lunora(api.pages.presence.leavePagePresence, null),
        // The editor saves once as it opens (it normalises the document); the page keeps its revision.
        lunora(api.pages.functions.savePageContent, { revision: page.revision }),
    ];
};

export const READ_ONLY_DOCUMENT = detail({ breadcrumbs: [], isOwner: false, permission: "comment" });

export const COLLABORATORS: Presence = [
    { isEditing: false, isSelf: false, userColor: "#8b5cf6", userName: "Mara Lindqvist" },
    { isEditing: true, isSelf: false, userColor: "#22c55e", userName: "Jonas Weber" },
];
