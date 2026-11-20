/**
 * A saved prompt records who wrote its current words (`content-author.ts`), from the session: an organization member's
 * edit of a teammate's prompt names the member and marks other writers, an admin acting as the user is flagged, both
 * marks stay until a restore, and a copy or a restore carries the record of the words it copies.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { schemaWithShardedTables } from "../lib/test-schema";
import { createPrompt, duplicatePrompt, restorePromptVersion, updatePrompt } from "./functions";

const OWNER = "user-owner";
const MEMBER = "user-member";
const ORG = "org-shared";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { impersonation, sessionFrom } = vi.hoisted(() => {
    // Set while a test acts as an admin impersonating the signed-in user.
    const state = { by: undefined as string | undefined };

    return {
        impersonation: state,
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: { id: "org-shared", name: "org", role: "member", slug: "org" },
                      id: context.auth.userId,
                      impersonatedBy: state.by,
                      isAdmin: false,
                      plan: "premium",
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

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const promptRow = async (promptId: string): Promise<Record<string, unknown>> =>
    await harness.run(async (context: any) => (await context.db.get("prompts", promptId)) as Record<string, unknown>);
const historyRows = async (promptId: string): Promise<Record<string, unknown>[]> =>
    await harness.run(async (context: any) => {
        const result = await context.db.promptHistory.findMany({ orderBy: [{ version: "asc" }], where: { promptId } });

        return result.page;
    });
const create = async (userId: string): Promise<string> =>
    (await as(userId).mutation(createPrompt as never, { content: "the owner's words", name: "Prompt", organizationId: ORG } as never)) as string;

beforeAll(async () => {
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables(["prompts", "promptHistory"]) as never);
});

afterEach(() => {
    impersonation.by = undefined;
    harness.close();
});

describe("prompt content author", () => {
    it("a new prompt names its writer, on the row and its first version", async () => {
        const promptId = await create(OWNER);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: false, contentByOthers: false, userId: OWNER });
        const [first] = await historyRows(promptId);

        expect(first).toMatchObject({ contentBy: OWNER, contentByImpersonator: false, contentByOthers: false });
    });

    it("an organization member's content edit names the member and marks other writers, which the owner's next edit keeps", async () => {
        const promptId = await create(OWNER);

        await as(MEMBER).mutation(updatePrompt as never, { content: "the member's words", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: MEMBER, contentByImpersonator: false, contentByOthers: true, userId: OWNER });

        // A part of the member's words may still stand: which part cannot be told.
        await as(OWNER).mutation(updatePrompt as never, { content: "the member's words, and the owner's", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: false, contentByOthers: true });
    });

    it("the owner's own edits of their own words keep them the sole writer", async () => {
        const promptId = await create(OWNER);

        await as(OWNER).mutation(updatePrompt as never, { content: "the owner's new words", promptId } as never);
        await as(OWNER).mutation(updatePrompt as never, { promptId, variables: [{ defaultValue: "the owner's default", name: "x" }] } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: false, contentByOthers: false });
    });

    it("the owner's edit of a variable's description, name or requirement leaves a teammate's default as the teammate's", async () => {
        const promptId = await create(OWNER);

        await as(MEMBER).mutation(updatePrompt as never, { promptId, variables: [{ defaultValue: "the member's default", name: "x" }] } as never);
        await as(OWNER).mutation(
            updatePrompt as never,
            { promptId, variables: [{ defaultValue: "the member's default", description: "what x is", name: "y", required: true }] } as never,
        );

        expect(await promptRow(promptId)).toMatchObject({ contentBy: MEMBER, contentByOthers: true });

        const history = await historyRows(promptId);

        expect(history.at(-1)).toMatchObject({ contentBy: MEMBER, contentByOthers: true });
    });

    it("a teammate's edit of only a variable's description writes no words", async () => {
        const promptId = await create(OWNER);

        await as(OWNER).mutation(updatePrompt as never, { promptId, variables: [{ defaultValue: "the owner's default", name: "x" }] } as never);
        await as(MEMBER).mutation(
            updatePrompt as never,
            { promptId, variables: [{ defaultValue: "the owner's default", description: "x", name: "x" }] } as never,
        );

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByOthers: false });
    });

    it("an edit that leaves the words alone keeps their writer", async () => {
        const promptId = await create(OWNER);

        await as(MEMBER).mutation(updatePrompt as never, { content: "the owner's words", model: "some-model", name: "Renamed", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, name: "Renamed" });

        const history = await historyRows(promptId);

        expect(history.at(-1)).toMatchObject({ contentBy: OWNER, contentByImpersonator: false });
    });

    it("a new variable default is words too: a member's names the member, an impersonating admin's is flagged", async () => {
        const promptId = await create(OWNER);

        await as(MEMBER).mutation(updatePrompt as never, { promptId, variables: [{ defaultValue: "planted words", name: "x" }] } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: MEMBER, contentByImpersonator: false, contentByOthers: true });

        impersonation.by = "admin-1";
        await as(OWNER).mutation(updatePrompt as never, { promptId, variables: [{ defaultValue: "other words", name: "x" }] } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: true });

        const history = await historyRows(promptId);

        expect(history.at(-1)).toMatchObject({ contentBy: OWNER, contentByImpersonator: true });
    });

    it("an admin acting as the owner is flagged on create and on edit, and the owner's next edit keeps the flag", async () => {
        impersonation.by = "admin-1";

        const promptId = await create(OWNER);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: true });

        await as(OWNER).mutation(updatePrompt as never, { content: "planted", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentByImpersonator: true });

        impersonation.by = undefined;
        await as(OWNER).mutation(updatePrompt as never, { content: "planted, and typed by the owner", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: true });
    });

    it("a restore carries the restored version's record, a duplicate the record of the words it copies", async () => {
        const promptId = await create(OWNER);

        await as(MEMBER).mutation(updatePrompt as never, { content: "the member's words", promptId } as never);
        await as(OWNER).mutation(updatePrompt as never, { content: "the owner's new words", promptId } as never);
        await as(OWNER).mutation(restorePromptVersion as never, { promptId, version: 2 } as never);

        expect(await promptRow(promptId)).toMatchObject({ content: "the member's words", contentBy: MEMBER, contentByOthers: true });

        // Restoring the first version puts back only the owner's words.
        await as(OWNER).mutation(restorePromptVersion as never, { promptId, version: 1 } as never);

        expect(await promptRow(promptId)).toMatchObject({ content: "the owner's words", contentBy: OWNER, contentByOthers: false });

        await as(OWNER).mutation(restorePromptVersion as never, { promptId, version: 2 } as never);
        const copyId = (await as(OWNER).mutation(duplicatePrompt as never, { promptId } as never)) as string;

        expect(await promptRow(copyId)).toMatchObject({ contentBy: MEMBER, contentByOthers: true, userId: OWNER });
        const [copyFirst] = await historyRows(copyId);

        expect(copyFirst).toMatchObject({ contentBy: MEMBER, contentByOthers: true });
    });

    it("restoring a version from before the field leaves the writer unset", async () => {
        const promptId = await create(OWNER);

        await harness.run(async (context: any) => {
            const result = await context.db.promptHistory.findMany({ where: { promptId } });
            const [first] = result.page;

            await context.db.replace("promptHistory", first._id, {
                changeType: first.changeType,
                content: first.content,
                createdAt: first.createdAt,
                note: first.note,
                promptId,
                userId: first.userId,
                version: first.version,
            });
        });
        await as(MEMBER).mutation(updatePrompt as never, { content: "the member's words", promptId } as never);
        await as(OWNER).mutation(restorePromptVersion as never, { promptId, version: 1 } as never);

        const row = await promptRow(promptId);

        expect(row["contentBy"]).toBeUndefined();
        expect(row["contentByImpersonator"]).toBeUndefined();
        expect(row["contentByOthers"]).toBeUndefined();
    });

    it("an edit of an organization prompt from before the fields counts its earlier words as anyone's", async () => {
        const promptId = await create(OWNER);

        await harness.run(async (context: any) => {
            const row = await context.db.get("prompts", promptId);

            await context.db.replace("prompts", promptId, {
                content: row.content,
                currentVersion: row.currentVersion,
                name: row.name,
                organizationId: row.organizationId,
                updatedAt: row.updatedAt,
                userId: row.userId,
            });
        });
        await as(OWNER).mutation(updatePrompt as never, { content: "the owner's new words", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByOthers: true });
    });

    it("on a personal prompt from before the fields, the owner's edit keeps them the sole writer and an admin's is flagged", async () => {
        const promptId = (await as(OWNER).mutation(createPrompt as never, { content: "the owner's words", name: "Prompt" } as never)) as string;

        await harness.run(async (context: any) => {
            const row = await context.db.get("prompts", promptId);

            await context.db.replace("prompts", promptId, {
                content: row.content,
                currentVersion: row.currentVersion,
                name: row.name,
                updatedAt: row.updatedAt,
                userId: row.userId,
            });
        });
        await as(OWNER).mutation(updatePrompt as never, { content: "the owner's new words", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: false, contentByOthers: false });

        impersonation.by = "admin-1";
        await as(OWNER).mutation(updatePrompt as never, { content: "planted", promptId } as never);

        expect(await promptRow(promptId)).toMatchObject({ contentBy: OWNER, contentByImpersonator: true, contentByOthers: false });
    });
});
