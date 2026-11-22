/**
 * No secret reaches `memories`: the pure rules that redact a fact or drop it, and the internal writes that every
 * extraction, compression and belief-revision path goes through.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { REDACTED } from "../lib/secret-redaction";
import { saveMemoryBatch, updateMemoryInternal } from "./functions";
import { applyReflectionOps } from "./reflection";
import { capMemoryText, recheckCutMemoryText, redactDigestSummary, redactMemoryFacts, redactMemoryText, redactReflectionOps } from "./redact";

/** Assembled at runtime so the file holds no literal that reads as a real credential. */
const TOKEN = ["gh", "p_", "Zq8LmV2xR7tYw4KpN3bC9dF6hJ1sA5gE0uIo"].join("");

describe("redactMemoryText", () => {
    it("keeps a fact without secrets as it is", () => {
        expect(redactMemoryText("User prefers dark mode since 2023.")).toBe("User prefers dark mode since 2023.");
    });

    it("keeps the fact around a redacted secret", () => {
        expect(redactMemoryText(`User deploys the blog with token ${TOKEN} from CI`)).toBe(`User deploys the blog with token ${REDACTED} from CI`);
    });

    it.each(["; ", ", "])("keeps the short fact before %j and a password", (separator) => {
        const field = ["pass", "word: "].join("");

        expect(redactMemoryText(`User is vegan${separator}${field}hunter2`)).toBe(`User is vegan${separator}${field}${REDACTED}`);
    });

    it("keeps an age stated beside a password, but not a numbered label alone", () => {
        const field = ["pass", "word: "].join("");

        expect(redactMemoryText(`User is 42; ${field}hunter2`)).toBe(`User is 42; ${field}${REDACTED}`);
        expect(redactMemoryText(`API key 2: ${TOKEN}`)).toBeNull();
    });

    it("keeps a fact before a colon and a password label", () => {
        const field = ["pass", "word: "].join("");

        expect(redactMemoryText(`User is vegan: ${field}hunter2`)).toBe(`User is vegan: ${field}${REDACTED}`);
    });

    it("keeps a label that says what the secret is for", () => {
        expect(redactMemoryText(`GitHub token for deploying the blog from CI: ${TOKEN}`)).toBe(`GitHub token for deploying the blog from CI: ${REDACTED}`);
    });

    it.each([
        `GitHub token: ${TOKEN}`,
        `GitHub personal access token: ${TOKEN}`,
        `password: hunter2`,
        TOKEN,
        `API_KEY=${TOKEN}`,
        `User's GitHub token is ${TOKEN}`,
        REDACTED,
        `Deploy key: ${REDACTED}`,
        "Netflix: password: hunter2",
        `Note: api_key: ${TOKEN}`,
    ])("drops %j, which is nothing but a secret", (text) => {
        expect(redactMemoryText(text)).toBeNull();
    });
});

describe(recheckCutMemoryText, () => {
    it("drops a cut that removed the marker and left only filler or a label", () => {
        const filler = `${"the ".repeat(124)}${REDACTED} and the user likes green tea`;
        const label = `password: ${REDACTED}; User likes tea`;

        expect(recheckCutMemoryText(filler, capMemoryText(filler, 500))).toBeNull();
        expect(recheckCutMemoryText(label, capMemoryText(label, "password: ".length + 3))).toBeNull();
    });

    it("keeps a cut that removed the marker but still states a fact", () => {
        const text = `User likes green tea and the API key ${REDACTED}`;

        expect(recheckCutMemoryText(text, capMemoryText(text, text.length - 3))).toBe("User likes green tea and the API key");
    });
});

describe("redactMemoryFacts", () => {
    it("redacts each fact and leaves out the secret-only ones", () => {
        const facts = [
            { memory: "User lives in Lisbon", type: "identity" },
            { memory: `password: hunter2`, type: "context" },
            { memory: `User's deploy key for staging is ${TOKEN}`, type: "context" },
        ];

        expect(redactMemoryFacts(facts)).toEqual({
            dropped: 1,
            facts: [
                { memory: "User lives in Lisbon", type: "identity" },
                { memory: `User's deploy key for staging is ${REDACTED}`, type: "context" },
            ],
            redacted: 1,
        });
    });
});

describe("redactReflectionOps", () => {
    it("redacts wording, keeps a row's text when the new wording is only a secret, and skips such a promotion", () => {
        expect(
            redactReflectionOps(
                [
                    { byMemoryId: "a", kind: "supersede", memoryId: "b" },
                    { confidence: 40, kind: "patch", memoryId: "c" },
                    { kind: "patch", lastConfirmedAt: 1, memory: `password: hunter2`, memoryId: "d" },
                    { kind: "patch", memory: `Works on the API with ${TOKEN} daily`, memoryId: "e" },
                    { confidence: 80, importance: 5, kind: "promote", memory: TOKEN, sourceIds: ["f"], type: "context" },
                ],
                500,
            ).ops,
        ).toEqual([
            { byMemoryId: "a", kind: "supersede", memoryId: "b" },
            { confidence: 40, kind: "patch", memoryId: "c" },
            { kind: "patch", lastConfirmedAt: 1, memoryId: "d" },
            { kind: "patch", memory: `Works on the API with ${REDACTED} daily`, memoryId: "e" },
        ]);
    });

    it("keeps the rows a merge would absorb when its wording was only a secret", () => {
        expect(
            redactReflectionOps(
                [
                    { kind: "patch", lastConfirmedAt: 1, memory: `password: hunter2`, memoryId: "survivor" },
                    { byMemoryId: "survivor", kind: "supersede", memoryId: "absorbed" },
                    { byMemoryId: "retired", kind: "supersede", memoryId: "retired" },
                    { kind: "patch", memory: "User drinks tea without sugar", memoryId: "other" },
                    { byMemoryId: "other", kind: "supersede", memoryId: "older" },
                ],
                500,
            ),
        ).toEqual({
            dropped: 1,
            ops: [
                { kind: "patch", lastConfirmedAt: 1, memoryId: "survivor" },
                { byMemoryId: "retired", kind: "supersede", memoryId: "retired" },
                { kind: "patch", memory: "User drinks tea without sugar", memoryId: "other" },
                { byMemoryId: "other", kind: "supersede", memoryId: "older" },
            ],
            redacted: 0,
        });
    });

    it("keeps the date check of a patch whose wording was only a secret", () => {
        const checkDates = { memory: { eventStart: "2026-11-20" } };

        expect(redactReflectionOps([{ checkDates, kind: "patch", lastConfirmedAt: 1, memory: "password: hunter2", memoryId: "survivor" }], 500).ops).toEqual([
            { checkDates, kind: "patch", lastConfirmedAt: 1, memoryId: "survivor" },
        ]);
    });

    it("drops a wording the cut leaves as nothing but a secret, and keeps the rows it would absorb", () => {
        const text = `password: hunter2, ${"1234 ".repeat(60)}, user likes green tea`;

        expect(
            redactReflectionOps(
                [
                    { kind: "patch", memory: text, memoryId: "survivor" },
                    { byMemoryId: "survivor", kind: "supersede", memoryId: "absorbed" },
                ],
                300,
            ).ops,
        ).toEqual([{ kind: "patch", memoryId: "survivor" }]);
    });

    it("drops a merge whose cut falls inside its marker and leaves only the label", () => {
        const text = `password: ${["hun", "ter2"].join("")}; User likes tea`;

        expect(
            redactReflectionOps(
                [
                    { kind: "patch", memory: text, memoryId: "survivor" },
                    { byMemoryId: "survivor", kind: "supersede", memoryId: "absorbed" },
                ],
                "password: ".length + 3,
            ).ops,
        ).toEqual([{ kind: "patch", memoryId: "survivor" }]);
    });

    it("cuts merge and promotion wording but stores a belief revision's merged text whole", () => {
        const long = `User ${"likes green tea and ".repeat(20)}black coffee`;
        const revision = { kind: "patch" as const, lastConfirmedAt: 1, memory: long, memoryId: "newer" };
        const { ops } = redactReflectionOps([{ kind: "patch", memory: long, memoryId: "merged" }, revision], 50, new Set([revision]));

        expect(ops).toEqual([{ kind: "patch", memory: long.slice(0, 50), memoryId: "merged" }, revision]);
    });

    it("redacts the whole wording before the cut, so the cut never leaves part of a secret", () => {
        const secret = ["alpha", " beta"].join("");
        const text = `User keeps API_KEY="${secret}" in the vault`;
        const [op] = redactReflectionOps([{ kind: "patch", memory: text, memoryId: "a" }], "User keeps API_KEY=".length + 4).ops;

        expect(op).toEqual({ kind: "patch", memory: "User keeps API_KEY=", memoryId: "a" });
    });
});

describe(redactDigestSummary, () => {
    it("never ends in part of a marker when the cut falls inside one", () => {
        const summary = `User set up CI with ${TOKEN} today`;

        expect(redactDigestSummary(summary, "User set up CI with ".length + 3)).toBe("User set up CI with");
        expect(redactDigestSummary(summary, 200)).toBe(`User set up CI with ${REDACTED} today`);
    });
});

describe("memory writes", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const readMemory = async (id: string): Promise<string | undefined> =>
        await harness.run(async (ctx: any) => ((await ctx.db.get("memories", id)) as { memory: string } | null)?.memory);

    it("never stores a secret, whatever the caller passed", async () => {
        const [id] = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    memories: [{ memory: `User's CI uses ${TOKEN} to publish`, source: "compressed", type: "context", userId: "user-1" }],
                }),
        );

        expect(await readMemory(id)).toBe(`User's CI uses ${REDACTED} to publish`);

        // A belief-revision UPDATE whose merged wording is only a secret leaves the row's text alone.
        await harness.run(async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { memory: `token=${TOKEN}`, memoryId: id }));

        expect(await readMemory(id)).toBe(`User's CI uses ${REDACTED} to publish`);

        await harness.run(
            async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { memory: `User's CI publishes with ${TOKEN} nightly`, memoryId: id }),
        );

        expect(await readMemory(id)).toBe(`User's CI publishes with ${REDACTED} nightly`);

        // Reflection writes its own wording: a merge and a promotion are redacted too.
        const { promotedIds } = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: `User's CI signs with ${TOKEN} weekly`, memoryId: id },
                        { confidence: 80, importance: 5, kind: "promote", memory: `User publishes via CI with ${TOKEN}`, sourceIds: [id], type: "context" },
                    ],
                    userId: "user-1",
                }),
        );

        expect(await readMemory(promotedIds[0])).toBe(`User publishes via CI with ${REDACTED}`);
        expect(JSON.stringify(await harness.run(async (ctx: any) => await ctx.db.query("memories").collect()))).not.toContain(TOKEN);
    });

    it("saves no row for a fact that is only a secret, and supersedes nothing for it", async () => {
        const [kept] = await harness.run(
            async (ctx: any) => await ctx.runMutation(saveMemoryBatch, { memories: [{ memory: "User lives in Lisbon", type: "identity", userId: "user-1" }] }),
        );
        const ids = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    memories: [
                        { memory: `API_KEY="${TOKEN}"`, supersedes: kept, type: "context", userId: "user-1" },
                        { memory: "User works in Porto", type: "identity", userId: "user-1" },
                    ],
                }),
        );

        expect(ids[0]).toBeNull();
        expect(await readMemory(ids[1])).toBe("User works in Porto");
        expect(await harness.run(async (ctx: any) => ((await ctx.db.get("memories", kept)) as { supersededBy?: string }).supersededBy)).toBeUndefined();
    });

    it("re-embeds a row whose wording an update changed, and only then", async () => {
        const [id] = await harness.run(
            async (ctx: any) => await ctx.runMutation(saveMemoryBatch, { memories: [{ memory: "User likes tea", type: "preference", userId: "user-1" }] }),
        );
        const jobs = () => harness.scheduler.list().map((job) => job.args);

        // Metadata only, the same wording, or a wording that is only a secret: the row's vector still matches its text.
        await harness.run(async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { confidence: 90, memoryId: id }));
        await harness.run(async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { memory: "User likes tea", memoryId: id }));
        await harness.run(async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { memory: `token=${TOKEN}`, memoryId: id }));

        expect(jobs()).toStrictEqual([]);

        await harness.run(
            async (ctx: any) => await ctx.runMutation(updateMemoryInternal, { memory: `User drinks green tea, CI token ${TOKEN}`, memoryId: id }),
        );

        expect(await readMemory(id)).toBe(`User drinks green tea, CI token ${REDACTED}`);
        expect(jobs()).toStrictEqual([{ memoryId: id, userId: "user-1" }]);
    });

    it("keeps a row's text and its sources when reflection writes only a secret", async () => {
        const [id] = await harness.run(
            async (ctx: any) => await ctx.runMutation(saveMemoryBatch, { memories: [{ memory: "User likes tea", type: "preference", userId: "user-1" }] }),
        );
        const result = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { confidence: 70, kind: "patch", memory: `API_KEY="${TOKEN}"`, memoryId: id },
                        { confidence: 80, importance: 5, kind: "promote", memory: `API_KEY="${TOKEN}"`, sourceIds: [id], type: "preference" },
                    ],
                    userId: "user-1",
                }),
        );
        const row = await harness.run(async (ctx: any) => (await ctx.db.get("memories", id)) as { confidence?: number; memory: string; supersededBy?: string });

        // One promotedIds entry per promote op, so the digest pairs each promotion with its own row.
        expect(result).toEqual({ applied: 1, promotedIds: [null], supersededIds: [], written: [] });
        expect(row.memory).toBe("User likes tea");
        expect(row.confidence).toBe(70);
        expect(row.supersededBy).toBeUndefined();
    });

    it("reports what reflection committed: the rows it superseded, no promotion of a pinned source, and the wording it wrote", async () => {
        const [survivor, absorbed, pinned, observed] = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMemoryBatch, {
                    memories: ["User likes tea", "User likes black tea", "User likes iced tea", "User had tea at noon"].map((memory) => {
                        return { memory, type: "preference", userId: "user-1" };
                    }),
                }),
        );

        // Pinned after the run was planned.
        await harness.run(async (ctx: any) => await ctx.db.patch("memories", pinned, { pinned: true }));

        const result = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(applyReflectionOps, {
                    ops: [
                        { kind: "patch", memory: `User likes black tea, CI token ${TOKEN}`, memoryId: survivor },
                        { byMemoryId: survivor, kind: "supersede", memoryId: absorbed },
                        { confidence: 80, importance: 5, kind: "promote", memory: "User drinks tea daily", sourceIds: [pinned, observed], type: "preference" },
                    ],
                    userId: "user-1",
                }),
        );

        // A source pinned since the synthesis leaves the promotion unmade, so `observed` stays too.
        expect(result.promotedIds).toEqual([null]);
        expect(result.supersededIds).toEqual([absorbed]);
        expect(result.written).toEqual([{ memory: `User likes black tea, CI token ${REDACTED}`, memoryId: survivor }]);
        // Each written row is re-embedded from the write itself.
        expect(harness.scheduler.list().map((job) => job.args)).toEqual([{ memoryId: survivor, userId: "user-1" }]);
    });
});
