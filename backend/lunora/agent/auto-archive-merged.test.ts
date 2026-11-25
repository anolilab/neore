/**
 * The merged-chat path: a chat linked to a pull request archives when that pull request merges, only when the owner turned
 * `autoArchiveMergedChats` on, and once per merge. Each test runs the real helper (`recordMergedPullRequest`) against the
 * harness, so the merge record, the archive and the settle step all go through their own mutations.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { recordMergedPullRequest } from "../source-control/pr-merged";
import { recordLinkState } from "../source-control/pr-state";
import { noteMergeAttempt, recordPullRequestMerged } from "../source-control/pr-threads";
import { archiveClosedLinkChat, archiveMergedThread } from "./auto-archive";
import { archiveThread } from "./threads";

/**
 * The helper names its mutations by their generated references; the harness runs the functions themselves. This maps each
 * reference the helper uses to the function it stands for, so the helper runs against the real mutations.
 */
const REGISTERED = new Map<unknown, unknown>([
    [internal.agent.auto_archive.archiveMergedThread, archiveMergedThread],
    [internal.source_control.pr_threads.noteMergeAttempt, noteMergeAttempt],
    [internal.source_control.pr_threads.recordPullRequestMerged, recordPullRequestMerged],
]);

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const REPOSITORY = "octo/hello";
const NUMBER = 7;
const URL = `https://github.com/${REPOSITORY}/pull/${String(NUMBER)}`;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

interface Setup {
    autoArchiveMergedChats?: boolean;
    /** When the link was made (ms). Defaults to long before any merge a test records. */
    linkCreatedAt?: number;
    linked?: boolean;
    /** When the owner turned the setting on (ms). Defaults to 0: every merge is after it. */
    optInAt?: number;
    pinned?: boolean;
}

/**
 * A recently active chat of OWNER, optionally linked to the pull request, with the setting as given. The chat is recent on
 * purpose: the merged path never waits for idleness.
 */
const setUp = (setup: Setup) =>
    harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", {
            mode: "text",
            model: "gpt-4o",
            pinnedAt: setup.pinned === true ? 1 : undefined,
            status: "active",
            title: "Feature work",
            updatedAt: Date.now(),
            userId: OWNER,
        });

        if (setup.autoArchiveMergedChats !== undefined) {
            await ctx.db.insert("userSettings", {
                autoArchiveMergedChats: setup.autoArchiveMergedChats,
                ...(setup.autoArchiveMergedChats === true && { autoArchiveMergedChatsSince: setup.optInAt ?? 0 }),
                userId: OWNER,
            });
        }

        if (setup.linked !== false) {
            await ctx.db.insert("pullRequestThreads", {
                createdAt: setup.linkCreatedAt ?? 1,
                kind: "attached",
                number: NUMBER,
                repository: REPOSITORY,
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
        }

        return threadId as string;
    });

/** A merge seen by a status read at `mergedAt` (absent: the person's own merge, now). Runs the real helper. */
const seeMerge = (mergedAt?: number, mergedBefore?: number) =>
    harness.run(async (ctx: any) => {
        await recordMergedPullRequest(
            { runMutation: (ref: unknown, args: unknown) => ctx.runMutation(REGISTERED.get(ref) ?? ref, args) } as never,
            OWNER,
            {
                number: NUMBER,
                repository: REPOSITORY,
            },
            mergedAt,
            mergedBefore,
        );
    });

const statusOf = (threadId: string) =>
    harness.run(async (ctx: any) => {
        const thread = await ctx.db.get("threads", threadId);

        return thread?.status;
    });

/** The id of the chat's link to the pull request, for the calls that take one. */
const linkIdOf = (threadId: string) =>
    harness.run(async (ctx: any) => {
        const [link] = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q: any) => q.eq("userId", OWNER).eq("threadId", threadId))
            .take(1);

        return link?._id;
    });

describe("archiveMergedThread", () => {
    it("archives a merged chat when the owner turned the setting on", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("keeps an open pull request's chat, even with the setting on", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });
        const linkId = await linkIdOf(threadId);
        const kept = await harness.run(
            async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId }),
        );

        expect(kept).toBe("declined");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a merged pull request's chat when the setting is off", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: false });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a merged pull request's chat when the setting was never set", async () => {
        const threadId = await setUp({});

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a chat with no linked pull request", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a pinned chat even when its pull request merged", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, pinned: true });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("archives a merge once: a chat reopened after the merge is not archived again by a later read", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        await seeMerge();
        expect(await statusOf(threadId)).toBe("archived");

        // The person reopens the chat: it becomes active again, as any new run or stream makes it.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "active" });
        });

        // A later status read of the same merged pull request owes nothing: the attempt settled.
        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("settles a chat's other link to the merged pull request when one archives it, so reopening it is not archived again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        // A second link of the same chat to the same pull request (an agent's link and a hand link).
        const second = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "linked",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );
        const [first, other] = [owed.find((row: { linkId: string }) => row.linkId !== second), owed.find((row: { linkId: string }) => row.linkId === second)];

        expect(owed).toHaveLength(2);
        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: first.linkId, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("archived");

        // The person reopens the chat before the second link is attempted.
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "active" });
        });

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: other.linkId, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("settles a sibling link past the chat's first 200 links, so reopening the chat is not archived again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        // More than 200 links of the same chat to other pull requests, then the sibling to the merged one. The owner turns the
        // open-pull-request rule off: a chat with more links than it reads is otherwise kept.
        const second = await harness.run(async (ctx: any) => {
            const settings = await ctx.db
                .query("userSettings")
                .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                .unique();

            await ctx.db.patch("userSettings", settings._id, { keepOpenPullRequestChats: false });

            for (let index = 0; index < 205; index += 1) {
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "linked",
                    number: 1000 + index,
                    repository: "octo/other",
                    state: "closed",
                    threadId,
                    title: "Other",
                    url: `https://github.com/octo/other/pull/${String(1000 + index)}`,
                    userId: OWNER,
                });
            }

            return await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "linked",
                number: NUMBER,
                repository: REPOSITORY,
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
        });

        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );
        const first = owed.find((row: { linkId: string }) => row.linkId !== second);

        expect(owed).toHaveLength(2);
        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: first.linkId, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("archived");

        const sibling = await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", second));

        expect(sibling?.mergeSettledAt).toBeTypeOf("number");
    });

    it("with the setting off, settles every link of a merge, so turning it on later archives none of those chats", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("userSettings", { autoArchiveMergedChats: false, userId: OWNER });

            for (let index = 0; index < 30; index += 1) {
                const threadId = await ctx.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "active",
                    title: "Chat",
                    updatedAt: Date.now(),
                    userId: OWNER,
                });

                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId,
                    title: "Chat",
                    url: URL,
                    userId: OWNER,
                });
            }
        });

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: NUMBER, repository: REPOSITORY, userId: OWNER }),
            ),
        ).toHaveLength(0);

        // The owner turns the setting on before any later read of the merged pull request.
        await harness.run(async (ctx: any) => {
            const settings = await ctx.db
                .query("userSettings")
                .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                .unique();

            await ctx.db.patch("userSettings", settings._id, { autoArchiveMergedChats: true, autoArchiveMergedChatsSince: 0 });
        });

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: NUMBER, repository: REPOSITORY, userId: OWNER }),
            ),
        ).toHaveLength(0);

        const archived = await harness.run(async (ctx: any) => {
            const threads = await ctx.db.query("threads").collect();

            return threads.filter((thread: { status: string; userId: string }) => thread.userId === OWNER && thread.status === "archived").length;
        });

        expect(archived).toBe(0);
    });

    it("keeps a chat whose pull request merged before the owner turned the setting on, even when the merge is first seen after", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, optInAt: 5000 });

        await seeMerge(1000);

        expect(await statusOf(threadId)).toBe("active");
    });

    it("archives a chat whose pull request merges after the owner turned the setting on", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, optInAt: 5000 });

        await seeMerge(6000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("settles a chat's other link when a pin declines one, so unpinning it later archives nothing", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, pinned: true });
        const second = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "linked",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );
        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );
        const first = owed.find((row: { linkId: string }) => row.linkId !== second);

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: first.linkId, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");

        // The owner unpins the chat before the other link is attempted.
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("threads", threadId);

            delete row.pinnedAt;
            await ctx.db.replace("threads", threadId, { ...row, status: "active" });
        });

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: second, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a chat linked after the pull request merged, when the host gives the merge time", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 5000 });

        // The host merged it at 1000, before the chat was linked to it.
        await seeMerge(1000);

        expect(await statusOf(threadId)).toBe("active");
    });

    it("archives a chat linked before the host's merge time", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 1000 });

        await seeMerge(5000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("archives a merge recorded at a later time in the same second as the opt-in", async () => {
        // The owner opted in at 5500. The host's merge time is whole seconds (5000), so it alone would look earlier; the merge was
        // requested at 5700, after the opt-in, and the recorded merge time is the later of the two.
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 1, optInAt: 5500 });

        await seeMerge(5700);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("keeps a link made after the host's second closed out of a merge, though the request came earlier", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 6200, optInAt: 5000 });

        // The host's second is 5000, so the merge ended before 6000; the request came at 5700. A link made at 6200 is too late.
        await seeMerge(5700, 6000);

        expect(await statusOf(threadId)).toBe("active");
    });

    it("archives a link made inside the host's second, where the merge may have come after it", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 5800, optInAt: 5000 });

        await seeMerge(5700, 6000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("keeps a busy merge owed when a later read carries a less precise time, so its retry still archives the chat", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, optInAt: 5500 });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "running" }));

        // The first read finds the chat busy: the merge is recorded at 5700, after the opt-in, and stays owed.
        await seeMerge(5700, 6700);
        expect(await statusOf(threadId)).toBe("running");

        // The chat is idle, and a later read sees the host's whole-second time (5000), before the opt-in. The stored time decides.
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));
        await seeMerge(5000, 6000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("keeps another merge of the chat owed when this link's merge predates the opt-in", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false, optInAt: 5000 });
        const { after, before } = await harness.run(async (ctx: any) => {
            const earlier = await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                mergedAt: 1000,
                number: NUMBER,
                repository: REPOSITORY,
                state: "merged",
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
            const later = await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                number: 8,
                repository: REPOSITORY,
                threadId,
                title: "Second",
                url: `https://github.com/${REPOSITORY}/pull/8`,
                userId: OWNER,
            });

            return { after: later, before: earlier };
        });

        // The second request merges after the opt-in and is recorded; the first merge predates the opt-in.
        await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 6000, number: 8, repository: REPOSITORY, userId: OWNER }),
        );

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: before, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");

        // The first decline is about its own merge, so the second merge is still owed and archives the chat.
        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: after, number: 8, repository: REPOSITORY, threadId })),
        ).toBe("archived");
    });

    it("archives a chat whose merged link was relinked (reset to open) once the host's merge is recorded again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(
            async (ctx: any) =>
                // The relink reset the state to open; the merge time and the owed attempt are still there.
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    mergedAt: 1000,
                    number: NUMBER,
                    repository: REPOSITORY,
                    state: "open",
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owed.map((row: { linkId: string }) => row.linkId)).toEqual([linkId]);

        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId })),
        ).toBe("archived");
    });

    it("keeps a recorded merge when an older check still reads the request open, so the archive still runs", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(
            async (ctx: any) =>
                // A state check leased at 500 is in flight when the merge is recorded.
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    stateCheckedAt: 500,
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owed.map((row: { linkId: string }) => row.linkId)).toEqual([linkId]);

        // The older check's answer lands after the merge: it reads the request open.
        await harness.run(async (ctx: any) => await ctx.runMutation(recordLinkState, { lease: 500, linkId, state: "open" }));

        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId })),
        ).toBe("archived");
    });

    it("archives a merged chat whose later duplicate link to the same request is not an open one", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 1 });

        // A hand-made duplicate of the request, linked after it merged.
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("pullRequestThreads", {
                createdAt: 5000,
                kind: "attached",
                number: NUMBER,
                repository: REPOSITORY,
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
        });

        await seeMerge(1000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("settles the chat's other owed merge when one merge archives it, so reopening the chat does not archive it again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });
        const otherLink = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: 8,
                    repository: REPOSITORY,
                    threadId,
                    title: "Second",
                    url: `https://github.com/${REPOSITORY}/pull/8`,
                    userId: OWNER,
                }),
        );

        const owedFirst = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );
        const owedSecond = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { mergedAt: 1000, number: 8, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owedSecond.map((row: { linkId: string }) => row.linkId)).toEqual([otherLink]);

        expect(
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(archiveMergedThread, { linkId: owedFirst[0].linkId, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("archived");

        // The owner reopens the chat; the second merge is still owed, and must not archive it again.
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: otherLink, number: 8, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");
    });

    it("archives a merged chat with more links than one read reaches, when none of them is open", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 110; index += 1) {
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "linked",
                    number: 2000 + index,
                    repository: "octo/other",
                    state: "closed",
                    threadId,
                    title: "Closed",
                    url: `https://github.com/octo/other/pull/${String(2000 + index)}`,
                    userId: OWNER,
                });
            }
        });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("does not let a stale attempt for an already-settled link settle a later merge, which then still archives the chat", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 1 });

        // The first merge archives the chat and settles its link.
        await seeMerge(1000);
        expect(await statusOf(threadId)).toBe("archived");
        const firstLink = await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("pullRequestThreads").collect();

            return rows.find((row: any) => row.number === NUMBER)?._id;
        });

        // The owner reopens the chat, and a second request to it merges.
        const secondLink = await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "active" });

            return await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                number: 8,
                repository: REPOSITORY,
                threadId,
                title: "Second",
                url: `https://github.com/${REPOSITORY}/pull/8`,
                userId: OWNER,
            });
        });
        // The second merge is after the archive written above: its time is taken from the stored archive time, not the wall clock.
        const archivedAt = await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("threads", threadId);

            return row?.archivedAt;
        });
        const owedSecond = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordPullRequestMerged, { mergedAt: archivedAt + 1000, number: 8, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owedSecond.map((row: { linkId: string }) => row.linkId)).toEqual([secondLink]);

        // A stale attempt for the first link, still in flight, runs now: the first link is settled, so it declines and stops.
        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: firstLink, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("declined");

        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: secondLink, number: 8, repository: REPOSITORY, threadId }),
            ),
        ).toBe("archived");
    });

    it("archives a chat once the other open request closes, for a merge kept owed while that request was open", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const { merged, open } = await harness.run(async (ctx: any) => {
            const mergedLink = await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                mergedAt: 1000,
                number: NUMBER,
                repository: REPOSITORY,
                state: "merged",
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
            const openLink = await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                number: 8,
                repository: REPOSITORY,
                state: "open",
                threadId,
                title: "Second",
                url: `https://github.com/${REPOSITORY}/pull/8`,
                userId: OWNER,
            });

            return { merged: mergedLink, open: openLink };
        });

        // The other request is still open: the merge stays owed (busy), not declined.
        expect(
            await harness.run(
                async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId: merged, number: NUMBER, repository: REPOSITORY, threadId }),
            ),
        ).toBe("busy");
        expect(await statusOf(threadId)).toBe("active");

        // The other request closes without merging: the close handler archives the chat for the merge it still owes.
        await harness.run(async (ctx: any) => await ctx.db.patch("pullRequestThreads", open, { state: "closed" }));

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(archiveClosedLinkChat, { threadId }))).toBe(true);
        expect(await statusOf(threadId)).toBe("archived");
    });

    it("settles a chat's owed merge when the idle archive archives it, so reopening the chat does not archive it again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(async (ctx: any) => {
            // Idle: the chat was last touched long ago, and auto-archive after one day is on.
            await ctx.db.patch("threads", threadId, { updatedAt: 1 });
            const settings = await ctx.db
                .query("userSettings")
                .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
                .unique();

            await ctx.db.patch("userSettings", settings._id, { autoArchiveAfterDays: 1 });

            return await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                mergedAt: 1000,
                number: NUMBER,
                repository: REPOSITORY,
                state: "merged",
                threadId,
                title: "Feature work",
                url: URL,
                userId: OWNER,
            });
        });

        expect(await harness.run(async (ctx: any) => await ctx.runMutation(archiveClosedLinkChat, { threadId }))).toBe(true);
        expect(await statusOf(threadId)).toBe("archived");

        // The idle archive settled the owed merge itself.
        const settled = await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("pullRequestThreads", linkId);

            return row?.mergeSettledAt;
        });

        expect(settled).toBeTypeOf("number");

        // The owner reopens the chat; the merge that the idle archive already covered must not archive it again.
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));

        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId })),
        ).toBe("declined");
    });

    it("settles a chat's owed merge when the owner archives the chat by hand, so reopening it does not archive it again", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    mergedAt: 1000,
                    number: NUMBER,
                    repository: REPOSITORY,
                    state: "merged",
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        await harness.run(async (ctx: any) => await ctx.runMutation(archiveThread, { threadId }));
        expect(await statusOf(threadId)).toBe("archived");

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));

        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId })),
        ).toBe("declined");
    });

    it("does not archive a reopened chat for a merge that happened before its manual archive, even when no read had recorded that merge", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        // The owner archives the chat by hand before any read has seen the merge.
        await harness.run(async (ctx: any) => await ctx.runMutation(archiveThread, { threadId }));
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));

        // Then a read finds the merge, which happened before that archive (time 1000 is earlier than the archive's now).
        await seeMerge(1000);

        expect(await statusOf(threadId)).toBe("active");
        const link = await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", linkId));

        expect(link?.mergeSettledAt).toBeTypeOf("number");
    });

    it("archives a reopened chat for a merge that came after its manual archive, when the host gave no merge time", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linked: false });
        const linkId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: URL,
                    userId: OWNER,
                }),
        );

        // The owner archives the chat while the merge is in flight, and reopens it.
        await harness.run(async (ctx: any) => await ctx.runMutation(archiveThread, { threadId }));
        const archivedAt = await harness.run(async (ctx: any) => {
            const row = await ctx.db.get("threads", threadId);

            return row?.archivedAt;
        });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "active" }));

        // The request was sent before the archive; the host gave no merge time, so nothing bounds the merge from above. The archive
        // does not cover it: the merge may have come after it.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordPullRequestMerged, {
                    mergedAt: archivedAt - 500,
                    mergedBefore: archivedAt - 500,
                    mergedBeforeIsHostBound: false,
                    number: NUMBER,
                    repository: REPOSITORY,
                    userId: OWNER,
                }),
        );

        expect(
            await harness.run(async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId })),
        ).toBe("archived");
    });

    it("keeps a merged chat that another open pull request keeps, as the idle archive does", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "linked",
                number: 9,
                repository: "octo/other",
                state: "open",
                threadId,
                title: "Still open",
                url: "https://github.com/octo/other/pull/9",
                userId: OWNER,
            });
        });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("archives a chat linked in the same second as the host's merge time, which may predate the merge", async () => {
        // The host gives whole seconds: the merge happened somewhere in [5000, 6000), after this link at 5500 was made.
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 5500 });

        await seeMerge(5000);

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("keeps a chat linked a whole second after the host's merge time", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, linkCreatedAt: 6000 });

        await seeMerge(5000);

        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps an attempt owed until it settles, so a failed archive is retried", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        const owed = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owed).toHaveLength(1);

        // The archive never ran (or failed), so nothing settled: the next read owes the same link again.
        const again = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );

        expect(again).toStrictEqual(owed);
        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a chat busy with a live run at merge time owed, and archives it once the run is over", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });
        const streamId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "m-1",
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "gpt-4o" },
                    threadId,
                    userId: OWNER,
                }),
        );

        await seeMerge();
        expect(await statusOf(threadId)).toBe("active");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("persistentStreams", streamId, { status: "done" });
        });

        // The attempt was still owed, so the next read archives it.
        await seeMerge();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("declines a chat pinned during a run at merge time, so unpinning it once the run is over archives nothing", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true, pinned: true });

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "running" });
        });

        await seeMerge();

        // The run ends and the person unpins the chat: the merge's attempt was already declined, so no later read archives it.
        await harness.run(async (ctx: any) => {
            // A pin is cleared by replacing the row without it: a patch cannot set an optional field back to nothing.
            const row = await ctx.db.get("threads", threadId);

            delete row.pinnedAt;
            await ctx.db.replace("threads", threadId, { ...row, status: "active" });
        });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("active");
    });

    it("keeps a chat whose agent is running at merge time owed, and archives it once the run is over", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "running" });
        });

        await seeMerge();
        expect(await statusOf(threadId)).toBe("running");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "active" });
        });

        await seeMerge();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("does not archive a settled link's chat again when the link is read after the person reopened it", async () => {
        const threadId = await setUp({ autoArchiveMergedChats: true });
        const linkId = await linkIdOf(threadId);

        await seeMerge();
        expect(await statusOf(threadId)).toBe("archived");

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId, { status: "active" });
        });

        const again = await harness.run(
            async (ctx: any) => await ctx.runMutation(archiveMergedThread, { linkId, number: NUMBER, repository: REPOSITORY, threadId }),
        );

        expect(again).toBe("declined");
        expect(await statusOf(threadId)).toBe("active");
    });

    it("reaches a ready chat behind more than 25 busy ones on the next read, rather than waiting behind them", async () => {
        const threadId = await harness.run(async (ctx: any) => {
            await ctx.db.insert("userSettings", { autoArchiveMergedChats: true, autoArchiveMergedChatsSince: 0, userId: OWNER });

            for (let index = 0; index < 30; index += 1) {
                const busy = await ctx.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "running",
                    title: "Busy",
                    updatedAt: Date.now(),
                    userId: OWNER,
                });

                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId: busy,
                    title: "Busy",
                    url: URL,
                    userId: OWNER,
                });
            }

            const mine = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Mine",
                updatedAt: Date.now(),
                userId: OWNER,
            });

            await ctx.db.insert("pullRequestThreads", {
                createdAt: 2,
                kind: "attached",
                number: NUMBER,
                repository: REPOSITORY,
                threadId: mine,
                title: "Mine",
                url: URL,
                userId: OWNER,
            });

            return mine as string;
        });

        // The first read finds the first 25 busy; the next reads the least recently attempted, which includes the ready chat.
        await seeMerge();
        expect(await statusOf(threadId)).toBe("active");

        await seeMerge();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("reaches a ready chat behind more than 25 chats whose archive attempt keeps throwing, rather than waiting behind them", async () => {
        // The attempts of these chats throw before they answer: nothing is stamped by the attempt itself.
        const failing = new Set<string>();
        const threadId = await harness.run(async (ctx: any) => {
            await ctx.db.insert("userSettings", { autoArchiveMergedChats: true, autoArchiveMergedChatsSince: 0, userId: OWNER });

            for (let index = 0; index < 30; index += 1) {
                const broken = await ctx.db.insert("threads", {
                    mode: "text",
                    model: "gpt-4o",
                    status: "active",
                    title: "Broken",
                    updatedAt: Date.now(),
                    userId: OWNER,
                });

                failing.add(String(broken));
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId: broken,
                    title: "Broken",
                    url: URL,
                    userId: OWNER,
                });
            }

            const mine = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Mine",
                updatedAt: Date.now(),
                userId: OWNER,
            });

            await ctx.db.insert("pullRequestThreads", {
                createdAt: 2,
                kind: "attached",
                number: NUMBER,
                repository: REPOSITORY,
                threadId: mine,
                title: "Mine",
                url: URL,
                userId: OWNER,
            });

            return mine as string;
        });

        const seeMergeWhileFailing = () =>
            harness.run(async (ctx: any) => {
                await recordMergedPullRequest(
                    {
                        runMutation: (ref: unknown, args: any) => {
                            if (ref === internal.agent.auto_archive.archiveMergedThread && failing.has(String(args.threadId))) {
                                return Promise.reject(new Error("the archive attempt failed"));
                            }

                            return ctx.runMutation(REGISTERED.get(ref) ?? ref, args);
                        },
                    } as never,
                    OWNER,
                    { number: NUMBER, repository: REPOSITORY },
                );
            });

        // The first read fails the first 25; a failed attempt is noted, so the next read's batch starts past them.
        await seeMergeWhileFailing();
        expect(await statusOf(threadId)).toBe("active");

        await seeMergeWhileFailing();

        expect(await statusOf(threadId)).toBe("archived");
    });

    it("does not owe a declined chat again once its attempt settled", async () => {
        await setUp({ autoArchiveMergedChats: true, pinned: true });

        await seeMerge();

        const owedAfter = await harness.run(
            async (ctx: any) => await ctx.runMutation(recordPullRequestMerged, { number: NUMBER, repository: REPOSITORY, userId: OWNER }),
        );

        expect(owedAfter).toStrictEqual([]);
    });

    it("reaches the chat's link behind more than 200 older links of the same pull request", async () => {
        const threadId = await harness.run(async (ctx: any) => {
            const older = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Older",
                updatedAt: Date.now(),
                userId: OWNER,
            });

            for (let index = 0; index < 205; index += 1) {
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number: NUMBER,
                    repository: REPOSITORY,
                    threadId: older,
                    title: "Older",
                    url: URL,
                    userId: OWNER,
                });
            }

            await ctx.db.insert("userSettings", { autoArchiveMergedChats: true, autoArchiveMergedChatsSince: 0, userId: OWNER });

            const mine = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Mine",
                updatedAt: Date.now(),
                userId: OWNER,
            });

            await ctx.db.insert("pullRequestThreads", {
                createdAt: 2,
                kind: "attached",
                number: NUMBER,
                repository: REPOSITORY,
                threadId: mine,
                title: "Mine",
                url: URL,
                userId: OWNER,
            });

            return mine as string;
        });

        // A read works through a bounded batch of owed links, so the chat behind the 205 older ones is reached on a later read.
        for (let read = 0; read < 20 && (await statusOf(threadId)) !== "archived"; read += 1) {
            await seeMerge();
        }

        expect(await statusOf(threadId)).toBe("archived");
    });
});
