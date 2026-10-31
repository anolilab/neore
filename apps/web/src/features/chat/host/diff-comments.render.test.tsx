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
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ one, other, value }: { one: string; other: string; value: number }) => (value === 1 ? one : other).split("#").join(String(value)),
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
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

const { useDiffCommentStore } = await import("@/features/chat/host/diff-comments-store");
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

    it("holds the send while a turn is running", async () => {
        harness.data["chat.streaming.getActiveStreamForThread"] = { _id: "s1" };
        mount({ tooLarge: true });
        useDiffCommentStore.getState().add("thread-1", { messageId: "m1", path: "b.md", text: "x" });

        const send = await screen.findByRole("button", { name: "Send to agent" });

        await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(true));
    });
});
