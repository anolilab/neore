/**
 * Workflow graphs and node execution outputs persist storage REFERENCES, not
 * the signed URLs the executor passes between nodes, and are signed again when
 * read. Plus the owner check the presence/version procedures were missing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { create as createNodeExecution, update as updateNodeExecution } from "../agent/node-executions";
import { signOwnedUrlFieldsForDisplay, signUrlFields, storageRefsInUrlFields, UNAVAILABLE_STORAGE_URL } from "../lib/stored-url-fields";
import { storageKeyOf, toStorageRef } from "../lib/storage-ref";
import { schemaWithShardedTables } from "../lib/test-schema";
import { getWorkflow } from "./functions";
import { getPublicWorkflow } from "./gallery";
import { listVersions, restoreVersion, saveVersion } from "./presence";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// session is read straight off the harness identity (as in `chat/thread-read-paths.test.ts`).
const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// `getPublicWorkflow` is an action that resolves the author through
// `ctx.runQuery(internal.workflow.gallery.…)` (docs/plans/per-user-sharding.md).
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "workflow_gallery", await import("./gallery"));
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

// `files` is audited, and its trigger writes the `.global()` `documentHistory`
// table the harness cannot store. Auditing is not what is under test.
vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

const ORIGIN = "http://localhost:8788";
const KEY = `agent-files/${"b".repeat(64)}`;
const SIGNED = `${ORIGIN}/${KEY}?exp=1&method=GET&bucket=default&sig=old`;

describe("URL fields in workflow JSON", () => {
    it("persists signed storage URLs in URL-named fields as references, and nothing else", () => {
        const stored = storageRefsInUrlFields(
            {
                assets: [{ imageUrl: SIGNED, mimeType: "image/png" }],
                content: SIGNED,
                imageUrls: [SIGNED],
                remote: { url: "https://fal.media/x.png" },
            },
            [ORIGIN],
        );

        expect(stored).toEqual({
            assets: [{ imageUrl: toStorageRef(KEY), mimeType: "image/png" }],
            // A text field is user-authored: never converted.
            content: SIGNED,
            imageUrls: [toStorageRef(KEY)],
            remote: { url: "https://fal.media/x.png" },
        });
    });

    it("reads a persisted reference back as a fresh signed URL each time", async () => {
        let calls = 0;
        const sign = async (key: string) => {
            calls += 1;

            return `${ORIGIN}/${key}?sig=fresh-${String(calls)}`;
        };
        const stored = { assets: [{ imageUrl: toStorageRef(KEY) }], note: toStorageRef(KEY) };

        expect(await signUrlFields(stored, { origins: [ORIGIN], sign })).toEqual({
            assets: [{ imageUrl: `${ORIGIN}/${KEY}?sig=fresh-1` }],
            note: toStorageRef(KEY),
        });
        expect(await signUrlFields(stored, { origins: [ORIGIN], sign })).toEqual({
            assets: [{ imageUrl: `${ORIGIN}/${KEY}?sig=fresh-2` }],
            note: toStorageRef(KEY),
        });
        // Legacy rows holding an expired URL are re-signed too.
        expect(await signUrlFields({ imageUrl: SIGNED }, { origins: [ORIGIN], sign })).toEqual({ imageUrl: `${ORIGIN}/${KEY}?sig=fresh-3` });
    });
});

describe("persisted workflow rows", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
        // `projects` is `.global()`; the harness has no D1 backend (see lib/test-schema.ts).
        harness = lunoraTest(schemaWithShardedTables(["projects"]) as never);
    });

    afterEach(() => {
        harness.close();
        vi.unstubAllEnvs();
    });

    const seedWorkflow = async (userId: string, fields: Record<string, unknown> = {}) =>
        (await harness.run(
            async (ctx: any) => await ctx.db.insert("projects", { name: "W", projectType: "workflow", title: "W", userId, ...fields }),
        )) as string;

    /** A content-addressed chat file `userId` stored (and so holds a grant for). */
    const seedOwnedChatFile = async (userId: string, key: string = KEY) =>
        await harness.run(async (ctx: any) => {
            const fileId = await ctx.db.insert("chatFiles", {
                hash: key.slice("agent-files/".length),
                lastTouchedAt: 0,
                mediaType: "image/png",
                refcount: 1,
                storageId: key,
            });

            await ctx.db.insert("chatFileAccess", { createdAt: 0, fileId, userId });
        });

    it("a node execution's output is stored with the key, not the signed URL", async () => {
        await seedOwnedChatFile("owner");
        const projectId = await seedWorkflow("owner");
        const nodeExecutionId = await harness.run(async (ctx: any) => {
            const executionId = await ctx.db.insert("workflowExecutions", { projectId, status: "running", userId: "owner" });
            const created = await ctx.runMutation(createNodeExecution, { executionId, nodeId: "n1", nodeType: "image", status: "running" });

            await ctx.runMutation(updateNodeExecution, {
                nodeExecutionId: created._id,
                output: { assets: [{ imageUrl: SIGNED }], modelId: "fal:flux-dev" },
                status: "completed",
            });

            return created._id;
        });
        const row = await harness.run(async (ctx: any) => await ctx.db.get(nodeExecutionId));

        expect(row.output).toEqual({ assets: [{ imageUrl: toStorageRef(KEY) }], modelId: "fal:flux-dev" });
    });

    it("keeps workflow versions to the workflow's owner", async () => {
        await seedOwnedChatFile("owner");
        const projectId = await seedWorkflow("owner");
        const owner = harness.withIdentity({ userId: "owner" });
        const stranger = harness.withIdentity({ userId: "stranger" });
        const content = { edges: [], nodes: [{ data: { imageUrl: SIGNED }, id: "n1", position: { x: 0, y: 0 }, type: "image" }] };

        const { versionId } = (await owner.mutation(saveVersion as never, { content, projectId } as never)) as { versionId: string };
        const stored = await harness.run(async (ctx: any) => await ctx.db.get(versionId));

        expect(stored.content.nodes[0].data.imageUrl).toBe(toStorageRef(KEY));

        await expect(stranger.query(listVersions as never, { projectId } as never)).rejects.toThrow();
        // Row-level security hides a stranger's version row: the answer a missing id gets.
        await expect(stranger.query(restoreVersion as never, { versionId } as never)).resolves.toBeNull();
        await expect(stranger.mutation(saveVersion as never, { content, projectId } as never)).rejects.toThrow();
        expect(await owner.query(listVersions as never, { projectId } as never)).toHaveLength(1);
    });

    describe("storage ownership", () => {
        const VICTIM_KEY = `agent-files/${"c".repeat(64)}`;
        const VAULT_KEY = "c6a6cf78-8d65-4181-8e49-9d155e10b38f";
        const signer = { getSignedUrl: async (key: string) => `${ORIGIN}/${key}?exp=9&method=GET&bucket=default&sig=fresh` };
        const graph = (imageUrl: string, extra: Record<string, unknown> = {}) => {
            return { edges: [], nodes: [{ data: { imageUrl, ...extra }, id: "n1", position: { x: 0, y: 0 }, type: "image" }] };
        };

        it("does not persist a reference to storage the saver does not own", async () => {
            await seedOwnedChatFile("victim", VICTIM_KEY);
            const projectId = await seedWorkflow("attacker");
            const attacker = harness.withIdentity({ userId: "attacker" });
            const forgedUrl = `${ORIGIN}/${VICTIM_KEY}?exp=1&method=GET&bucket=default&sig=forged`;

            const { versionId } = (await attacker.mutation(
                saveVersion as never,
                { content: graph(toStorageRef(VICTIM_KEY), { maskUrl: forgedUrl }), projectId } as never,
            )) as { versionId: string };

            const stored = await harness.run(async (ctx: any) => await ctx.db.get(versionId));

            expect(stored.content.nodes[0].data).toEqual({ imageUrl: UNAVAILABLE_STORAGE_URL, maskUrl: UNAVAILABLE_STORAGE_URL });
        });

        it("keeps the owner's own chat file and vault file", async () => {
            await seedOwnedChatFile("owner");
            await harness.run(async (ctx: any) => await ctx.db.insert("files", { key: VAULT_KEY, name: "a.png", size: 1, type: "image/png", userId: "owner" }));
            const projectId = await seedWorkflow("owner");
            const owner = harness.withIdentity({ userId: "owner" });

            const { versionId } = (await owner.mutation(
                saveVersion as never,
                { content: graph(SIGNED, { fileUrl: toStorageRef(VAULT_KEY) }), projectId } as never,
            )) as { versionId: string };

            const stored = await harness.run(async (ctx: any) => await ctx.db.get(versionId));

            expect(stored.content.nodes[0].data).toEqual({ fileUrl: toStorageRef(VAULT_KEY), imageUrl: toStorageRef(KEY) });
        });

        it("signs only the data owner's keys on read — a planted foreign key is stripped, not signed", async () => {
            await seedOwnedChatFile("owner");
            await seedOwnedChatFile("victim", VICTIM_KEY);

            const read = await harness.run(
                async (ctx: any) =>
                    await signOwnedUrlFieldsForDisplay({ db: ctx.db, storage: signer }, "owner", {
                        mine: { imageUrl: toStorageRef(KEY) },
                        planted: { imageUrl: toStorageRef(VICTIM_KEY) },
                    }),
            );

            expect(read).toEqual({
                mine: { imageUrl: `${ORIGIN}/${KEY}?exp=9&method=GET&bucket=default&sig=fresh` },
                planted: { imageUrl: UNAVAILABLE_STORAGE_URL },
            });
        });

        it("the owner's and the public view drop a reference planted in the row directly", async () => {
            await seedOwnedChatFile("owner");
            await seedOwnedChatFile("victim", VICTIM_KEY);
            const projectId = await seedWorkflow("owner", {
                isPublic: true,
                publicAccessToken: "share-token",
                workflowContent: {
                    edges: [],
                    nodes: [{ data: { imageUrl: toStorageRef(VICTIM_KEY), maskUrl: toStorageRef(KEY) }, id: "n1", position: { x: 0, y: 0 }, type: "image" }],
                },
            });

            const publicView = (await harness.action(getPublicWorkflow as never, { publicAccessToken: "share-token" } as never)) as any;
            const ownerView = (await harness.withIdentity({ userId: "owner" }).query(getWorkflow as never, { projectId } as never)) as any;

            // No storage is bound in the harness, so the owner's key stays a reference; the foreign one is gone.
            for (const view of [publicView, ownerView]) {
                expect(view.workflowContent.nodes[0].data).toEqual({ imageUrl: UNAVAILABLE_STORAGE_URL, maskUrl: toStorageRef(KEY) });
            }
        });
    });
});

describe("storageKeyOf", () => {
    it("does not take a bare ?sig= on our origin as a signed storage URL", () => {
        // A key shape storage does not mint, so only a signature could make it ours.
        const key = "reports/q3.pdf";

        expect(storageKeyOf(`${ORIGIN}/${key}?sig=x`, [ORIGIN])).toBeNull();
        expect(storageKeyOf(`${ORIGIN}/${key}?exp=soon&method=GET&bucket=default&sig=x`, [ORIGIN])).toBeNull();
        expect(storageKeyOf(`${ORIGIN}/${key}?exp=1&method=PUT&bucket=default&sig=x`, [ORIGIN])).toBeNull();
        expect(storageKeyOf(`${ORIGIN}/${key}?exp=1&method=GET&bucket=default&sig=x`, [ORIGIN])).toBe(key);
    });
});
