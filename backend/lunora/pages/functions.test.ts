/**
 * The Pages procedures against the in-memory harness: who may read, comment,
 * write and restructure; the tree's cycle check; version grouping; the public
 * projection; and the GDPR sweep.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { createPageComment, deletePageComment, listPageComments } from "./comments";
import { createPage, deletePage, getPage, listPageTree, listPageVersions, movePage, restorePageVersion, savePageContent, setPageFavorite } from "./functions";
import { deleteUserPages } from "./gdpr";
import { acceptPageInvite, createPageInvite, getPublicPage, removePageGrant, setPagePublic } from "./sharing";

// `acceptPageInvite` / `getPublicPage` are actions that resolve their owner
// through `ctx.runQuery(internal.pages.sharing.…)` (docs/plans/per-user-sharding.md).
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "pages_sharing", await import("./sharing"));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
                : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const OWNER = "owner";
const READER = "reader";
const COMMENTER = "commenter";
const WRITER = "writer";
const STRANGER = "stranger";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const docWith = (...paragraphs: unknown[][]) => {
    return {
        content: paragraphs.map((content) => {
            return { content, type: "paragraph" };
        }),
        type: "doc",
    };
};
const text = (value: string, marks?: unknown[]) => (marks ? { marks, text: value, type: "text" } : { text: value, type: "text" });

const newPage = async (userId = OWNER, args: Record<string, unknown> = {}): Promise<string> => {
    const { pageId } = (await as(userId).mutation(createPage as never, { title: "Page", ...args } as never)) as { pageId: string };

    return pageId;
};

/** The page's current revision — what a fresh editor would base its save on. */
const rev = async (pageId: string): Promise<number> => await harness.run(async (ctx: any) => ((await ctx.db.get(pageId)) as { revision: number }).revision);

const grant = async (pageId: string, userId: string, permission: string): Promise<void> => {
    const { token } = (await as(OWNER).mutation(createPageInvite as never, { expiresInDays: 7, pageId, permission } as never)) as { token: string };

    await as(userId).action(acceptPageInvite as never, { token } as never);
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("access", () => {
    it("hides a page from anyone without a grant, as not-found", async () => {
        const pageId = await newPage();

        await expect(as(STRANGER).query(getPage as never, { pageId } as never)).rejects.toThrow("Page not found");
        await expect(
            as(STRANGER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("x")]), pageId } as never),
        ).rejects.toThrow("Page not found");
    });

    it("lets each grant do exactly what its permission allows", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("The quick fox")]), pageId } as never);
        await grant(pageId, READER, "read");
        await grant(pageId, COMMENTER, "comment");
        await grant(pageId, WRITER, "write");

        // read: sees the page and its comments, cannot comment or write.
        await expect(as(READER).query(getPage as never, { pageId } as never)).resolves.toMatchObject({ isOwner: false, permission: "read" });
        await expect(as(READER).query(listPageComments as never, { pageId } as never)).resolves.toEqual([]);

        const marked = docWith([text("The "), text("quick", [{ attrs: { commentId: "c1" }, type: "comment" }]), text(" fox")]);

        await expect(
            as(READER).mutation(
                createPageComment as never,
                { baseRevision: await rev(pageId), body: "hi", commentId: "c1", contentJson: marked, pageId } as never,
            ),
        ).rejects.toThrow("permission");

        // comment: may add the anchor mark, but not smuggle in an edit alongside it.
        const edited = docWith([text("The "), text("quick", [{ attrs: { commentId: "c2" }, type: "comment" }]), text(" fox EDITED")]);

        await expect(
            as(COMMENTER).mutation(
                createPageComment as never,
                { baseRevision: await rev(pageId), body: "hi", commentId: "c2", contentJson: edited, pageId } as never,
            ),
        ).rejects.toThrow("not edit");
        await expect(
            as(COMMENTER).mutation(
                createPageComment as never,
                { baseRevision: await rev(pageId), body: "Nice", commentId: "c1", contentJson: marked, pageId } as never,
            ),
        ).resolves.toMatchObject({
            commentRowId: expect.any(String),
        });
        await expect(
            as(COMMENTER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("x")]), pageId } as never),
        ).rejects.toThrow("permission");

        // write: edits content; the tree stays the owner's.
        await expect(
            as(WRITER).mutation(
                savePageContent as never,
                { baseRevision: await rev(pageId), contentJson: docWith([text("The quick fox, edited")]), pageId } as never,
            ),
        ).resolves.toBeDefined();
        await expect(as(WRITER).mutation(deletePage as never, { pageId } as never)).rejects.toThrow("Page not found");
        await expect(as(WRITER).mutation(setPagePublic as never, { isPublic: true, pageId } as never)).rejects.toThrow("permission");

        // The grantees see it under "shared", not in their own tree.
        const tree = (await as(WRITER).query(listPageTree as never, {} as never)) as { owned: unknown[]; shared: { permission: string }[] };

        expect(tree.owned).toEqual([]);
        expect(tree.shared).toEqual([expect.objectContaining({ permission: "write" })]);

        // Leaving removes the grant.
        await as(WRITER).mutation(removePageGrant as never, { pageId, targetUserId: WRITER } as never);
        await expect(as(WRITER).query(getPage as never, { pageId } as never)).rejects.toThrow("Page not found");
    });

    it("spends an invite on first use", async () => {
        const pageId = await newPage();
        const { token } = (await as(OWNER).mutation(createPageInvite as never, { expiresInDays: 1, pageId, permission: "read" } as never)) as { token: string };

        await as(READER).action(acceptPageInvite as never, { token } as never);
        await expect(as(STRANGER).action(acceptPageInvite as never, { token } as never)).rejects.toThrow("not valid");
    });
});

describe("tree", () => {
    it("refuses to move a page into its own subtree", async () => {
        const root = await newPage();
        const child = await newPage(OWNER, { parentPageId: root });
        const grandchild = await newPage(OWNER, { parentPageId: child });

        await expect(as(OWNER).mutation(movePage as never, { index: 0, pageId: root, parentPageId: grandchild } as never)).rejects.toThrow("inside itself");
        await expect(as(OWNER).mutation(movePage as never, { index: 0, pageId: grandchild, parentPageId: null } as never)).resolves.toBeNull();
    });

    it("deletes a page with its whole subtree", async () => {
        const root = await newPage();
        const child = await newPage(OWNER, { parentPageId: root });

        await newPage(OWNER, { parentPageId: child });

        await expect(as(OWNER).mutation(deletePage as never, { pageId: root } as never)).resolves.toEqual({ deleted: 3 });
        await expect(as(OWNER).query(listPageTree as never, {} as never)).resolves.toMatchObject({ owned: [] });
    });
});

describe("versions", () => {
    it("groups autosaves in one window, gives an agent edit its own version, and restores", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("one")]), pageId } as never);
        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("one two")]), pageId } as never);

        let versions = (await as(OWNER).query(listPageVersions as never, { pageId } as never)) as { _id: string; reason: string }[];

        expect(versions).toHaveLength(1);

        await as(OWNER).mutation(
            savePageContent as never,
            { baseRevision: await rev(pageId), contentJson: docWith([text("rewritten")]), pageId, reason: "agent" } as never,
        );
        versions = (await as(OWNER).query(listPageVersions as never, { pageId } as never)) as { _id: string; reason: string }[];
        expect(versions.map((version) => version.reason)).toEqual(["agent", "edit"]);

        await as(OWNER).mutation(restorePageVersion as never, { baseRevision: await rev(pageId), versionId: versions[1]!._id } as never);

        const page = (await as(OWNER).query(getPage as never, { pageId } as never)) as { contentJson: unknown };

        expect(page.contentJson).toEqual(docWith([text("one two")]));
    });

    it("re-anchors a comment when a restore drops its mark", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("The quick fox")]), pageId } as never);

        const [version] = (await as(OWNER).query(listPageVersions as never, { pageId } as never)) as { _id: string }[];
        const marked = docWith([text("The "), text("quick", [{ attrs: { commentId: "c1" }, type: "comment" }]), text(" fox")]);

        await as(OWNER).mutation(
            createPageComment as never,
            { baseRevision: await rev(pageId), body: "note", commentId: "c1", contentJson: marked, pageId } as never,
        );
        await as(OWNER).mutation(restorePageVersion as never, { baseRevision: await rev(pageId), versionId: version!._id } as never);

        const page = (await as(OWNER).query(getPage as never, { pageId } as never)) as { contentJson: unknown };
        const [thread] = (await as(OWNER).query(listPageComments as never, { pageId } as never)) as { anchorText: string; orphaned: boolean }[];

        expect(JSON.stringify(page.contentJson)).toContain('"commentId":"c1"');
        expect(thread).toMatchObject({ anchorText: "quick", orphaned: false });
    });
});

describe("public link", () => {
    it("serves a redacted copy without comment marks, and nothing once unpublished", async () => {
        const pageId = await newPage();
        const marked = docWith([text("The "), text("quick", [{ attrs: { commentId: "c1" }, type: "comment" }]), text(" fox")]);

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: marked, pageId } as never);

        const { publicAccessToken } = (await as(OWNER).mutation(setPagePublic as never, { isPublic: true, pageId } as never)) as { publicAccessToken: string };
        const shared = (await harness.action(getPublicPage as never, { publicAccessToken } as never)) as Record<string, unknown>;

        expect(Object.keys(shared).toSorted((a, b) => a.localeCompare(b))).toEqual(["contentJson", "icon", "title", "updatedAt"]);
        expect(JSON.stringify(shared.contentJson)).not.toContain("comment");

        await as(OWNER).mutation(setPagePublic as never, { isPublic: false, pageId } as never);
        await expect(harness.action(getPublicPage as never, { publicAccessToken } as never)).resolves.toBeNull();
    });
});

describe("gdpr", () => {
    it("deletes the user's pages and comments, and anonymises their versions on others' pages", async () => {
        const own = await newPage(WRITER);
        const others = await newPage();

        await grant(others, WRITER, "write");
        await as(WRITER).mutation(
            savePageContent as never,
            { baseRevision: await rev(others), contentJson: docWith([text("by writer")]), pageId: others } as never,
        );
        await as(WRITER).mutation(savePageContent as never, { baseRevision: await rev(own), contentJson: docWith([text("mine")]), pageId: own } as never);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserPages, { userId: WRITER }));

        const rows = (await harness.run(async (ctx: any) => {
            return {
                access: await ctx.db.query("pageAccess").collect(),
                pages: await ctx.db.query("pages").collect(),
                versions: await ctx.db.query("pageVersions").collect(),
            };
        })) as { access: unknown[]; pages: { userId: string }[]; versions: { userId: string }[] };

        expect(rows.pages.map((page) => page.userId)).toEqual([OWNER]);
        expect(rows.access).toEqual([]);
        expect(rows.versions.map((version) => version.userId)).toEqual(["deleted-user"]);
    });
});

describe("concurrent saves", () => {
    const conflictOf = async (promise: Promise<unknown>): Promise<{ data: { code: string; contentJson: unknown; revision: number } }> => {
        try {
            await promise;
        } catch (error) {
            return error as never;
        }

        throw new Error("expected a conflict");
    };

    it("rejects a save based on a stale revision, with the current page, and accepts an explicit overwrite", async () => {
        const pageId = await newPage();

        await grant(pageId, WRITER, "write");

        const base = await rev(pageId);

        // The writer saves first; the owner's editor still holds `base`.
        await as(WRITER).mutation(savePageContent as never, { baseRevision: base, contentJson: docWith([text("writer's text")]), pageId } as never);

        const error = await conflictOf(
            as(OWNER).mutation(savePageContent as never, { baseRevision: base, contentJson: docWith([text("owner's text")]), pageId } as never),
        );

        expect(error.data.code).toBe("PAGE_REVISION_CONFLICT");
        expect(error.data.contentJson).toEqual(docWith([text("writer's text")]));

        // Nothing was lost: the writer's text is still what is stored.
        await expect(as(OWNER).query(getPage as never, { pageId } as never)).resolves.toMatchObject({ contentJson: docWith([text("writer's text")]) });

        // "Overwrite" = a second save on the revision the conflict reported.
        await as(OWNER).mutation(
            savePageContent as never,
            { baseRevision: error.data.revision, contentJson: docWith([text("owner's text")]), pageId } as never,
        );
        await expect(as(OWNER).query(getPage as never, { pageId } as never)).resolves.toMatchObject({ contentJson: docWith([text("owner's text")]) });
    });

    it("applies the same check to restore", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("v1")]), pageId } as never);

        const [version] = (await as(OWNER).query(listPageVersions as never, { pageId } as never)) as { _id: string }[];
        const stale = await rev(pageId);

        await as(OWNER).mutation(savePageContent as never, { baseRevision: stale, contentJson: docWith([text("v2")]), pageId } as never);

        await expect(as(OWNER).mutation(restorePageVersion as never, { baseRevision: stale, versionId: version!._id } as never)).rejects.toThrow(
            "changed while you were editing",
        );
    });

    it("does not treat someone else's comment activity as a conflict", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("The quick fox")]), pageId } as never);
        await grant(pageId, COMMENTER, "comment");

        const ownerBase = await rev(pageId);
        const marked = docWith([text("The "), text("quick", [{ attrs: { commentId: "c1" }, type: "comment" }]), text(" fox")]);

        await as(COMMENTER).mutation(
            createPageComment as never,
            { baseRevision: ownerBase, body: "hm", commentId: "c1", contentJson: marked, pageId } as never,
        );

        // The owner's save, based before the comment, lacks its mark: accepted, and the mark re-anchored.
        const result = (await as(OWNER).mutation(
            savePageContent as never,
            {
                baseRevision: ownerBase,
                contentJson: docWith([text("The quick fox jumps")]),
                pageId,
            } as never,
        )) as { contentJson: unknown };

        expect(JSON.stringify(result.contentJson)).toContain('"commentId":"c1"');
    });
});

describe("deleting a comment", () => {
    it("strips its highlight from the stored page, even for a comment-only author", async () => {
        const pageId = await newPage();

        await as(OWNER).mutation(savePageContent as never, { baseRevision: await rev(pageId), contentJson: docWith([text("The quick fox")]), pageId } as never);
        await grant(pageId, COMMENTER, "comment");

        const marked = docWith([text("The "), text("quick", [{ attrs: { commentId: "c1" }, type: "comment" }]), text(" fox")]);
        const { commentRowId } = (await as(COMMENTER).mutation(
            createPageComment as never,
            {
                baseRevision: await rev(pageId),
                body: "hm",
                commentId: "c1",
                contentJson: marked,
                pageId,
            } as never,
        )) as { commentRowId: string };
        const before = await rev(pageId);

        const { revision } = (await as(COMMENTER).mutation(deletePageComment as never, { commentRowId } as never)) as { revision: number };
        const page = (await as(OWNER).query(getPage as never, { pageId } as never)) as { contentJson: unknown };

        expect(revision).toBe(before + 1);
        expect(JSON.stringify(page.contentJson)).not.toContain("comment");
        expect(page.contentJson).toEqual(docWith([text("The quick fox")]));
    });
});

describe("favorites", () => {
    it("are per user, so a collaborator can star a shared page", async () => {
        const pageId = await newPage();

        await grant(pageId, READER, "read");
        await as(READER).mutation(setPageFavorite as never, { isFavorite: true, pageId } as never);

        const readerTree = (await as(READER).query(listPageTree as never, {} as never)) as { shared: { isFavorite: boolean }[] };
        const ownerTree = (await as(OWNER).query(listPageTree as never, {} as never)) as { owned: { isFavorite: boolean }[] };

        expect(readerTree.shared[0]?.isFavorite).toBe(true);
        expect(ownerTree.owned[0]?.isFavorite).toBe(false);
        await expect(as(STRANGER).mutation(setPageFavorite as never, { isFavorite: true, pageId } as never)).rejects.toThrow("Page not found");

        // Losing access drops the star.
        await as(OWNER).mutation(removePageGrant as never, { pageId, targetUserId: READER } as never);

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("pageFavorites").collect())) as unknown[];

        expect(rows).toEqual([]);
    });
});
