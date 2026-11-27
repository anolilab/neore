/** An install with more links than one call may delete takes several calls, in both the rollback and the uninstall, and keeps its install until the last. */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { createInstallRow, deleteInstall, finishInstall } from "./install-steps";
import { finishUninstallRows, uninstallRows } from "./uninstall";

const OWNER = "owner-a";
const SLUG = "daily-brief";
const HASH = "b".repeat(64);
const LINKS = 25;

describe("links deleted a few at a time", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(async () => {
        const { loadAllFunctions } = await import("../_generated/functions");

        await loadAllFunctions();
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const run = async <T>(function_: (context: any) => Promise<T>): Promise<T> => await harness.run(async (context: any) => await function_(context));

    const installWithLinks = async () => {
        const { generation, installId } = await run(
            async (context) => await context.runMutation(createInstallRow, { contentHash: HASH, pluginSlug: SLUG, userId: OWNER, version: "1.0.0" }),
        );

        await run(async (context) => {
            for (let index = 0; index < LINKS; index += 1) {
                await context.db.insert("pluginItems", {
                    contentHash: HASH,
                    createdAt: 0,
                    entryKey: `skill:${String(index)}`,
                    installId,
                    kind: "skill",
                    state: "created",
                    userId: OWNER,
                });
            }
        });

        return { generation, installId };
    };

    const linksLeft = async (installId: string) => {
        const { page } = await run(async (context) => await context.db.pluginItems.findMany({ where: { installId } }));

        return page.length;
    };
    const installRow = async (installId: string) => await run(async (context) => await context.db.pluginInstalls.findFirst({ where: { _id: installId } }));

    it("rolls an install back over several calls, and removes the install only with the last link", async () => {
        const { generation, installId } = await installWithLinks();
        const answers: boolean[] = [];

        for (let call = 0; call < 10; call += 1) {
            const { hasMore } = await run(async (context) => await context.runMutation(deleteInstall, { generation, installId }));

            answers.push(hasMore);

            if (!hasMore) {
                break;
            }

            expect(await installRow(installId)).not.toBeNull();
        }

        expect(answers).toEqual([true, true, false]);
        expect(await linksLeft(installId)).toBe(0);
        expect(await installRow(installId)).toBeNull();
    });

    it("finishes an uninstall over several calls, and removes the install only with the last link", async () => {
        const { generation, installId } = await installWithLinks();

        await run(async (context) => await context.runMutation(finishInstall, { generation, installId }));

        const begun = await run(async (context) => await uninstallRows(context, OWNER, SLUG));
        const answers: boolean[] = [];

        for (let call = 0; call < 10; call += 1) {
            const { hasMore } = await run(async (context) => await finishUninstallRows(context, begun.installId, begun.generation));

            answers.push(hasMore);

            if (!hasMore) {
                break;
            }

            expect(await installRow(installId)).not.toBeNull();
        }

        expect(answers).toEqual([true, true, false]);
        expect(await linksLeft(installId)).toBe(0);
        expect(await installRow(installId)).toBeNull();
    });
});
