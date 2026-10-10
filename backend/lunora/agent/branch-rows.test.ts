/**
 * The branch walk that serves requests (`branch-rows.ts`, paged by
 * `listActivePathPage`), driven against the real schema. The whole-thread form
 * in `branch-tree.ts` is only for forks and deleted leaves; see its own test.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { contextPathIds } from "./branch-rows";
import { BRANCH_ROOT } from "./branch-tree";
import { listActivePathPage } from "./branches";

type Harness = ReturnType<typeof lunoraTest>;

/** `[name, order, stepOrder, parent?]`; a name starting with `u` is a user prompt. */
type Spec = [string, number, number, string?];

const OWNER = "owner-user";

let harness: Harness;
let threadId: string;
let ids: Record<string, string>;
let names: Map<string, string>;

/**
 * Inserts rows in the given sequence. A parent that is inserted later (a
 * forward reference) is patched in afterwards; one that never is stays a
 * dangling string.
 */
const seed = async (specs: Spec[]) => {
    for (const [name, order, stepOrder] of specs) {
        const role = name.startsWith("u") ? "user" : "assistant";
        const id: string = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("messages", {
                    message: { content: name, role },
                    order,
                    status: "success",
                    stepOrder,
                    threadId,
                    tool: false,
                    userId: OWNER,
                }),
        );

        ids[name] = id;
        names.set(id, name);
    }

    for (const spec of specs) {
        const parent = spec[3];

        if (parent === undefined) {
            continue;
        }

        const parentMessageId = parent === BRANCH_ROOT ? BRANCH_ROOT : (ids[parent] ?? parent);

        await harness.run(async (ctx: any) => await ctx.db.patch(ids[spec[0]], { parentMessageId }));
    }
};

const nameOf = (id: string) => names.get(id) ?? id;

/** The active page for a stored leaf: rows newest first, and each row's sibling info — all by name. */
const pageOf = async (leaf: string) => {
    await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { activeLeafMessageId: ids[leaf] ?? leaf }));

    const thread = await harness.run(async (ctx: any) => await ctx.db.get(threadId));
    const page: any = await harness.run(async (ctx: any) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 1000 }));
    const branches = new Map<string, { count: number; index: number; siblingIds: string[] }>();

    for (const [id, branch] of page.branches) {
        branches.set(nameOf(id), { ...branch, siblingIds: branch.siblingIds.map((siblingId: string) => nameOf(siblingId)) });
    }

    expect(page.isDone).toBe(true);

    return { branches, rows: page.page as { _id: string }[] };
};

/** The active path for a stored leaf, top first, by name. */
const pathOf = async (leaf: string): Promise<string[]> => {
    const { rows } = await pageOf(leaf);

    return rows.map((row) => nameOf(row._id)).toReversed();
};

const branchesOf = async (leaf: string) => {
    const { branches } = await pageOf(leaf);

    return branches;
};

const contextOf = async (prompt: string): Promise<string[]> => {
    const contextIds: string[] = await harness.run(async (ctx: any) => {
        const row = await ctx.db.get(ids[prompt]);

        return await contextPathIds(ctx, threadId as never, row);
    });

    return contextIds.map((id) => nameOf(id));
};

/** u1 → a1 (two steps) → u2 → a2, written before branching existed. */
const legacy: Spec[] = [
    ["u1", 0, 0],
    ["a1", 0, 1],
    ["a1-step2", 0, 2],
    ["u2", 1, 0],
    ["a2", 1, 1],
];

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));
    ids = {};
    names = new Map();
});

afterEach(() => {
    harness.close();
});

describe("branch walk", () => {
    it("reads rows without parent ids as one linear path", async () => {
        await seed(legacy);

        const branches = await branchesOf("a2");

        expect(await pathOf("a2")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
        expect(branches.size).toBe(0);
    });

    it("descends from a stored leaf that is not a leaf", async () => {
        await seed(legacy);

        expect(await pathOf("a1")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
    });

    it("falls back to the latest path for a stored leaf that no longer exists", async () => {
        await seed(legacy);

        expect(await pathOf("deleted")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
    });

    describe("branch at an assistant message (regenerate)", () => {
        // a2b is a second reply to u2; its later step follows it implicitly.
        const rows: Spec[] = [...legacy, ["a2b", 1, 2, "u2"], ["a2b-step2", 1, 3]];

        beforeEach(async () => {
            await seed(rows);
        });

        it("puts the newest reply on the path by default", async () => {
            expect(await pathOf("u2")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2b", "a2b-step2"]);
        });

        it("switches back to the first reply", async () => {
            expect(await pathOf("a2")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
        });

        it("reports both replies as siblings", async () => {
            const onFirst = await branchesOf("a2");
            const onSecond = await branchesOf("a2b");

            expect(onFirst.get("a2")).toStrictEqual({ count: 2, index: 0, siblingIds: ["a2", "a2b"] });
            expect(onSecond.get("a2b")).toStrictEqual({ count: 2, index: 1, siblingIds: ["a2", "a2b"] });
            expect(onSecond.get("a2b-step2")).toBeUndefined();
        });

        it("keeps the old reply out of the regenerated reply's context", async () => {
            expect(await contextOf("u2")).toStrictEqual(["u1", "a1", "a1-step2", "u2"]);
        });
    });

    describe("branch at a user message (edit)", () => {
        // u2b replaces u2: same parent (a1-step2), appended at a new order.
        beforeEach(async () => {
            await seed([...legacy, ["u2b", 2, 0, "a1-step2"], ["a2c", 2, 1]]);
        });

        it("follows the edited prompt and its reply", async () => {
            const branches = await branchesOf("u2b");

            expect(await pathOf("u2b")).toStrictEqual(["u1", "a1", "a1-step2", "u2b", "a2c"]);
            expect(branches.get("u2b")).toStrictEqual({ count: 2, index: 1, siblingIds: ["u2", "u2b"] });
        });

        it("keeps the original prompt reachable", async () => {
            expect(await pathOf("u2")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
        });
    });

    describe("edit of the first prompt", () => {
        beforeEach(async () => {
            await seed([...legacy, ["u1b", 2, 0, BRANCH_ROOT], ["a1c", 2, 1]]);
        });

        it("starts a top-level sibling", async () => {
            expect(await pathOf("u1b")).toStrictEqual(["u1b", "a1c"]);
            const branches = await branchesOf("u1");

            expect(branches.get("u1")).toStrictEqual({ count: 2, index: 0, siblingIds: ["u1", "u1b"] });
        });

        it("defaults to the latest top-level branch when the stored leaf is gone", async () => {
            expect(await pathOf("deleted")).toStrictEqual(["u1b", "a1c"]);
        });
    });

    describe("nested branches", () => {
        // u1 → a1 → { u2 → { a2, a2b → u3 → a3 }, u2b → a2c }
        beforeEach(async () => {
            await seed([
                ["u1", 0, 0],
                ["a1", 0, 1],
                ["u2", 1, 0],
                ["a2", 1, 1],
                ["a2b", 1, 2, "u2"],
                ["u2b", 2, 0, "a1"],
                ["a2c", 2, 1],
                // Sent while a2b was active, so it names its parent explicitly.
                ["u3", 3, 0, "a2b"],
                ["a3", 3, 1],
            ]);
        });

        it("descends by latest child from a switch point", async () => {
            expect(await pathOf("u2")).toStrictEqual(["u1", "a1", "u2", "a2b", "u3", "a3"]);
            expect(await pathOf("a2")).toStrictEqual(["u1", "a1", "u2", "a2"]);
            expect(await pathOf("u2b")).toStrictEqual(["u1", "a1", "u2b", "a2c"]);
        });

        it("does not let an implicit parent cross into a sibling branch", async () => {
            // u2b sits right after a2b in storage order but belongs under a1.
            expect(await pathOf("a2c")).not.toContain("a2b");
            // u3 sits right after a2c but belongs under a2b.
            expect(await pathOf("a3")).not.toContain("a2c");
        });

        it("reports siblings at each level independently", async () => {
            const branches = await branchesOf("a3");

            expect(branches.get("u2")?.siblingIds).toStrictEqual(["u2", "u2b"]);
            expect(branches.get("a2b")?.siblingIds).toStrictEqual(["a2", "a2b"]);
            expect(branches.get("u3")).toBeUndefined();
        });

        it("continues a non-user prompt along its latest chain", async () => {
            expect(await contextOf("a2b")).toStrictEqual(["u1", "a1", "u2", "a2b", "u3", "a3"]);
        });
    });

    it("falls back to the previous row for a forward or dangling parent", async () => {
        await seed([
            ["u1", 0, 0],
            ["a1", 0, 1, "a-later"],
            ["a-later", 0, 2],
            ["u2", 1, 0, "gone"],
        ]);

        expect(await pathOf("u2")).toStrictEqual(["u1", "a1", "a-later", "u2"]);
        expect(await pathOf("u1")).toStrictEqual(["u1", "a1", "a-later", "u2"]);
    });
});
