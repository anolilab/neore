// @vitest-environment jsdom

/**
 * Commenting on a host turn's diff: selecting lines with the keyboard, the labelled comment box, the draft and its
 * count, and the one send that goes through the host composer's own path.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        /** Everything that left the page: sends, and any procedure call other than a read. */
        calls: [] as [string, unknown][],
        data: {} as Record<string, unknown>,
        sendResults: [] as ({ error: string; ok: false } | { ok: true })[],
        /** Words a test wants translated: `t` answers a message that is exactly one of these keys with its value. */
        translations: {} as Record<string, string>,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ one, other, value }: { one: string; other: string; value: number }) => (value === 1 ? one : other).split("#").join(String(value)),
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => {
                    const message = String.raw({ raw: strings }, ...values);

                    return harness.translations[message] ?? message;
                },
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/features/chat/host/host-send", () => {
    return {
        MAX_HOST_PROMPT_CHARS: 30_000,
        sendHostMessage: vi.fn(async (input: unknown) => {
            harness.calls.push(["send", input]);

            return harness.sendResults.shift() ?? { ok: true };
        }),
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const node = (path: string[]): object =>
        new Proxy(
            {},
            {
                get: (_target, key) => {
                    if (key === "queryOptions") {
                        return (args: unknown) => {
                            return { queryFn: async () => harness.data[path.join(".")] ?? null, queryKey: [path.join("."), args] };
                        };
                    }

                    if (key === "mutationOptions") {
                        return () => {
                            return {
                                mutationFn: async (args: unknown) => {
                                    harness.calls.push([path.join("."), args]);

                                    return {};
                                },
                            };
                        };
                    }

                    return node([...path, String(key)]);
                },
            },
        );

    return { useCRPC: () => node([]) };
});

// The dialog's scroll area measures itself; jsdom has no layout.
/* eslint-disable class-methods-use-this -- an inert stand-in */
class InertResizeObserver {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}
/* eslint-enable class-methods-use-this */

const { MAX_DRAFT_COMMENTS, useDiffCommentStore } = await import("@/features/chat/host/diff-comments-store");
const { default: HostChanges } = await import("@/features/chat/thread/host-changes");
const { default: DiffCommentsDraft } = await import("@/features/chat/host/diff-comments-draft");

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,3 +3,4 @@", " keep one", "-old line", "+new line", "+another new line", " keep two", ""].join("\n");

const FILES = [
    { added: 2, path: "src/a.ts", removed: 1 },
    { added: 4, path: "b.md", removed: 0 },
];

const mount = (patch: string | { tooLarge: true }) =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <HostChanges changes={{ files: FILES, patch }} messageId="m1" threadId="thread-1" />
            <DiffCommentsDraft threadId="thread-1" />
        </QueryClientProvider>,
    );

const TWO_HUNKS = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,2 @@", " one", "+two", "@@ -20,2 +21,1 @@", "-gone", " twenty", ""].join("\n");
const TWO = /\+two$/u;
const GONE = /-gone$/u;
const TWENTY = / twenty$/u;
const ONE = / one$/u;
const REMOVED_WORD = /\(removed\)/u;
const NEW_LINE = /\+new line$/u;
const ANOTHER_LINE = /\+another new line$/u;

/** Selects the "+new line" and "+another new line" lines with the keyboard and writes a comment on them. */
const commentOnTwoLines = async (text: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Open diff" }));

    const first = await screen.findByRole("option", { name: NEW_LINE });

    act(() => first.focus());
    fireEvent.keyDown(first, { key: " " });
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(screen.getByRole("option", { name: ANOTHER_LINE }), { key: "Enter" });

    const box = await screen.findByLabelText("Comment on src/a.ts, lines 4-5");

    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
};

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
    Element.prototype.getAnimations = () => [];
    harness.calls = [];
    harness.sendResults = [];
    harness.translations = {};
    harness.data = { "acp.functions.getHostSession": { status: "idle" } };
    useDiffCommentStore.setState({ drafts: {} });
});

describe("commenting on a turn's diff", () => {
    it("selects a range with the keyboard, labels the box with its file and lines, and drafts the comment", async () => {
        mount(PATCH);
        await commentOnTwoLines("Why two lines?");

        expect(useDiffCommentStore.getState().drafts["thread-1"]).toEqual([
            {
                id: expect.any(String),
                messageId: "m1",
                path: "src/a.ts",
                range: { from: 4, hunk: "@@ -3,3 +3,4 @@", lineIds: ["line-5", "line-6"], quoted: ["+new line", "+another new line"], side: "new", to: 5 },
                text: "Why two lines?",
            },
        ]);
        const statuses = await screen.findAllByRole("status");

        expect(statuses.some((node) => node.textContent === "1 comment ready to send to the agent")).toBe(true);
    });

    it("comments on the focused line, not on a selection the focus has left", async () => {
        mount(PATCH);
        fireEvent.click(screen.getByRole("button", { name: "Open diff" }));

        const first = await screen.findByRole("option", { name: NEW_LINE });

        act(() => first.focus());
        fireEvent.keyDown(first, { key: " " });
        fireEvent.keyDown(first, { key: "ArrowDown" });
        fireEvent.keyDown(screen.getByRole("option", { name: ANOTHER_LINE }), { key: "Enter" });

        expect(await screen.findByLabelText("Comment on src/a.ts, lines 5")).toBeDefined();
    });

    it("only selects lines of one file, and never a header or hunk line", async () => {
        mount(PATCH);
        fireEvent.click(screen.getByRole("button", { name: "Open diff" }));

        const options = await screen.findAllByRole("option");

        expect(options.map((option) => option.textContent)).toEqual([" keep one", "-old line", "+new line", "+another new line", " keep two"]);
    });

    it("sends the comments as one message through the host send, and clears the draft only once it is accepted", async () => {
        mount(PATCH);
        await commentOnTwoLines("Why two lines?");
        harness.sendResults = [{ error: "offline", ok: false }];

        const draft = within(screen.getByRole("region", { name: "Comments for the agent" }));

        fireEvent.click(draft.getByRole("button", { name: "Send to agent" }));
        await waitFor(() => expect(harness.calls).toHaveLength(1));
        // Refused: the comments are all still there.
        await waitFor(() => expect((draft.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement).disabled).toBe(false));
        expect(useDiffCommentStore.getState().drafts["thread-1"]).toHaveLength(1);

        fireEvent.click(draft.getByRole("button", { name: "Send to agent" }));
        await waitFor(() => expect(harness.calls).toHaveLength(2));
        await waitFor(() => expect(useDiffCommentStore.getState().drafts["thread-1"]).toBeUndefined());

        const sent = harness.calls.map(([, input]) => input as { requestId: string; text: string; threadId: string });
        const [first, second] = sent;

        // The same comments are the same message: a retry finds the first try instead of starting a second turn.
        expect(second?.requestId).toBe(first?.requestId);
        expect(second?.threadId).toBe("thread-1");
        expect(second?.text).toContain("Comment 1 on src/a.ts, lines 4-5:\n```diff\n@@ -3,3 +3,4 @@\n+new line\n+another new line\n```\nWhy two lines?");
        // Nothing but the host send left the page: no procedure, no other request.
        expect(harness.calls.map(([name]) => name)).toEqual(["send", "send"]);
    });

    it("keeps a comment added while the send was in flight", async () => {
        mount(PATCH);
        await commentOnTwoLines("first");

        const { add } = useDiffCommentStore.getState();
        const draft = within(screen.getByRole("region", { name: "Comments for the agent" }));

        fireEvent.click(draft.getByRole("button", { name: "Send to agent" }));
        act(() => add("thread-1", { messageId: "m1", path: "b.md", text: "late" }));
        await waitFor(() => expect(useDiffCommentStore.getState().drafts["thread-1"]?.map((comment) => comment.text)).toEqual(["late"]));
    });

    it("lets a comment be removed, and the draft be discarded", async () => {
        mount(PATCH);
        await commentOnTwoLines("one");

        const draft = within(screen.getByRole("region", { name: "Comments for the agent" }));

        fireEvent.click(draft.getByRole("button", { name: "Remove the comment on src/a.ts:4-5" }));
        expect(useDiffCommentStore.getState().drafts["thread-1"]).toBeUndefined();
    });

    it("offers only file-level comments when the diff was too large to keep", async () => {
        mount({ tooLarge: true });

        expect(screen.queryByRole("button", { name: "Open diff" })).toBeNull();
        expect(screen.queryByRole("listbox")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Comment on src/a.ts" }));
        fireEvent.change(await screen.findByLabelText("Comment on the whole file src/a.ts"), { target: { value: "Split it" } });
        fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

        expect(useDiffCommentStore.getState().drafts["thread-1"]).toEqual([{ id: expect.any(String), messageId: "m1", path: "src/a.ts", text: "Split it" }]);

        fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
        await waitFor(() => expect(harness.calls).toHaveLength(1));
        expect((harness.calls[0]?.[1] as { text: string }).text).toContain("Comment 1 on src/a.ts (the whole file):\nSplit it");
    });

    it("returns focus to the button that opened a file comment when the box closes", async () => {
        mount({ tooLarge: true });

        const opener = screen.getByRole("button", { name: "Comment on src/a.ts" });

        fireEvent.click(opener);
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(opener);

        fireEvent.click(opener);
        fireEvent.change(await screen.findByLabelText("Comment on the whole file src/a.ts"), { target: { value: "Split it" } });
        fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(opener);
    });

    it("holds the send while a turn is running", async () => {
        harness.data["chat.streaming.getActiveStreamForThread"] = { _id: "s1" };
        mount({ tooLarge: true });
        useDiffCommentStore.getState().add("thread-1", { messageId: "m1", path: "b.md", text: "x" });

        const send = await screen.findByRole("button", { name: "Send to agent" });

        await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(true));
    });

    it("keeps the comment box open, says the draft is full and will not add a 31st comment", async () => {
        mount({ tooLarge: true });

        const { add } = useDiffCommentStore.getState();

        act(() => {
            for (let index = 0; index < MAX_DRAFT_COMMENTS - 1; index += 1) {
                add("thread-1", { messageId: "m1", path: "b.md", text: `comment ${String(index)}` });
            }
        });

        fireEvent.click(screen.getByRole("button", { name: "Comment on src/a.ts" }));

        const box = await screen.findByLabelText("Comment on the whole file src/a.ts");

        fireEvent.change(box, { target: { value: "the last one" } });
        expect(screen.queryByRole("alert")?.textContent ?? "").not.toContain("full");
        fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
        expect(useDiffCommentStore.getState().drafts["thread-1"]).toHaveLength(MAX_DRAFT_COMMENTS);

        // The draft is full now: a 31st comment is neither stored nor lost from the box, which stays with its text.
        fireEvent.click(screen.getByRole("button", { name: "Comment on src/a.ts" }));
        fireEvent.change(await screen.findByLabelText("Comment on the whole file src/a.ts"), { target: { value: "one too many" } });

        const alert = screen.getAllByRole("alert").find((node) => node.textContent?.includes("full"));

        expect(alert?.textContent).toContain("full");
        expect((screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.keyDown(screen.getByLabelText("Comment on the whole file src/a.ts"), { ctrlKey: true, key: "Enter" });
        expect(useDiffCommentStore.getState().drafts["thread-1"]).toHaveLength(MAX_DRAFT_COMMENTS);
        expect((screen.getByLabelText("Comment on the whole file src/a.ts") as HTMLTextAreaElement).value).toBe("one too many");
    });

    describe("a diff with two hunks", () => {
        const open = async () => {
            mount(TWO_HUNKS);
            fireEvent.click(screen.getByRole("button", { name: "Open diff" }));
            await screen.findAllByRole("option");
        };

        const selected = (name: RegExp) => screen.getByRole("option", { name }).getAttribute("aria-selected") === "true";

        it("does not extend a selection from one hunk into the next with the keyboard", async () => {
            await open();

            const two = screen.getByRole("option", { name: TWO });

            act(() => two.focus());
            fireEvent.keyDown(two, { key: " " });
            fireEvent.keyDown(two, { key: "ArrowDown", shiftKey: true });

            expect(selected(TWO)).toBe(true);
            expect(selected(GONE)).toBe(false);

            fireEvent.keyDown(two, { key: "Enter" });
            expect(await screen.findByLabelText("Comment on src/a.ts, lines 2")).toBeTruthy();
        });

        it("starts a new selection when shift-click lands in another hunk, and moves focus freely without shift", async () => {
            await open();
            fireEvent.click(screen.getByRole("option", { name: TWO }));
            fireEvent.click(screen.getByRole("option", { name: TWENTY }), { shiftKey: true });

            expect(selected(TWO)).toBe(false);
            expect(selected(GONE)).toBe(false);
            expect(selected(TWENTY)).toBe(true);

            const two = screen.getByRole("option", { name: TWO });

            act(() => two.focus());
            fireEvent.keyDown(two, { key: "ArrowDown" });
            // eslint-disable-next-line testing-library/no-node-access -- focus is a property of the document, not of a queried node
            expect(document.activeElement).toBe(screen.getByRole("option", { name: GONE }));
        });

        it("still extends a selection within one hunk", async () => {
            await open();

            const first = screen.getByRole("option", { name: ONE });

            act(() => first.focus());
            fireEvent.keyDown(first, { key: " " });
            fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });

            expect(selected(TWO)).toBe(true);
        });

        it("words a removed line in the person's language in the box label and the draft, not in English", async () => {
            harness.translations = { removed: "entfernt" };
            await open();
            fireEvent.click(screen.getByRole("option", { name: GONE }));
            fireEvent.keyDown(screen.getByRole("option", { name: GONE }), { key: "Enter" });

            const box = await screen.findByLabelText("Comment on src/a.ts, lines 20 (entfernt)");

            fireEvent.change(box, { target: { value: "why" } });
            fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

            expect(await screen.findByRole("button", { name: "Remove the comment on src/a.ts:20 (entfernt)" })).toBeTruthy();
            expect(screen.queryByText(REMOVED_WORD)).toBeNull();
        });
    });

    it("sends comments recreated after a failed send under a new request id, so they are not mistaken for its retry", async () => {
        mount({ tooLarge: true });

        const { add, clear } = useDiffCommentStore.getState();

        act(() => add("thread-1", { messageId: "m1", path: "b.md", text: "same words" }));
        harness.sendResults = [{ error: "unreachable", ok: false }];
        fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
        await waitFor(() => expect(harness.calls).toHaveLength(1));
        await waitFor(() => expect((screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement).disabled).toBe(false));

        // The person discards the comments and writes the same ones again: a new message.
        act(() => clear("thread-1"));
        act(() => add("thread-1", { messageId: "m1", path: "b.md", text: "same words" }));
        fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
        await waitFor(() => expect(harness.calls).toHaveLength(2));

        const [first, second] = harness.calls.map(([, input]) => input as { requestId: string; text: string });

        expect(second?.text).toBe(first?.text);
        expect(second?.requestId).not.toBe(first?.requestId);
    });
});
