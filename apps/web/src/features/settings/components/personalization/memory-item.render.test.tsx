/**
 * A memory row says who learned it and when, loads the user's own words on
 * expand, and links to the chat only when the backend gives a link. A dated
 * memory shows its days in the list: the day or days an event happens, and the
 * last day a fact holds. A stored day is a calendar day, so the viewer's
 * timezone never shifts it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryItemData } from "./memory-item";
import MemoryItem from "./memory-item";

type Source = { messageId?: string; quote?: string; quoteHidden?: boolean; threadId?: string } | null;

/** What the next `getMemorySource` request answers: a source, a request that never settles, or a failure. */
const harness = vi.hoisted(() => {
    return {
        requests: 0,
        respond: (): Promise<Source> => Promise.resolve(null),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { date: (value: Date, format: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", format).format(value) },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                memory: {
                    functions: {
                        getMemorySource: {
                            queryOptions: ({ memoryId }: { memoryId: string }) => {
                                return {
                                    queryFn: () => {
                                        harness.requests += 1;

                                        return harness.respond();
                                    },
                                    queryKey: ["memorySource", memoryId],
                                    retry: false,
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, hash, params }: { children: React.ReactNode; hash?: string; params: { threadId: string } }) => (
            <a href={`/chat/${params.threadId}${hash ? `#${hash}` : ""}`}>{children}</a>
        ),
    };
});

const WHY_RE = /Why was this remembered\?/u;
const OPEN_MESSAGE_RE = /Open message/u;

const base: MemoryItemData = {
    _id: "memory-1",
    createdAt: Date.UTC(2026, 10, 17, 12),
    fromBot: false,
    hasEvidence: true,
    lastConfirmedAt: 0,
    memory: "The user is a nurse",
    pinned: false,
    source: "auto",
    threadId: "thread-1",
    type: "identity",
};

/** A memory with no source to show, for the date tests. */
const dated: MemoryItemData = {
    _id: "m1",
    createdAt: 0,
    fromBot: false,
    hasEvidence: false,
    lastConfirmedAt: 0,
    memory: "User is travelling",
    pinned: false,
    type: "context",
};

const answer = (source: Source) => {
    harness.respond = () => Promise.resolve(source);
};

const renderMemory = (memory: MemoryItemData, onSave = vi.fn()) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryItem busy={false} memory={memory} onDelete={vi.fn()} onSave={onSave} onTogglePin={vi.fn()} relativeTime={() => "now"} />
        </QueryClientProvider>,
    );

const renderItem = (memory: Partial<MemoryItemData>) => renderMemory({ ...base, ...memory });

beforeEach(() => {
    answer(null);
    harness.requests = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("memory item provenance", () => {
    it.each([
        [{ botName: "Chef", fromBot: true }, "Learned by Chef · Nov 17, 2026"],
        [{ botOwnedByOther: true, fromBot: true }, "Learned by the shared chat's bot · Nov 17, 2026"],
        [{ fromBot: true }, "Learned by a deleted bot · Nov 17, 2026"],
        [{ botOwnerUnknown: true, fromBot: true }, "Learned by a bot · Nov 17, 2026"],
        [{}, "Learned in chat · Nov 17, 2026"],
        [{ source: "manual" }, "Added by you · Nov 17, 2026"],
        [{ source: "import" }, "Nov 17, 2026"],
    ] as const)("labels %o as %s", (memory, label) => {
        expect.assertions(1);

        renderItem(memory);

        expect(screen.getByText(label)).toBeDefined();
    });

    it("loads the quote and the message link only on expand", async () => {
        expect.assertions(3);

        answer({ messageId: "message-1", quote: "I work as a nurse", threadId: "thread-1" });
        renderItem({});

        expect(harness.requests).toBe(0);

        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("“I work as a nurse”")).toBeDefined();
        expect(screen.getByRole("link", { name: OPEN_MESSAGE_RE }).getAttribute("href")).toBe("/chat/thread-1#message-message-1");
    });

    it("shows the quote without a link when the chat can no longer be opened", async () => {
        expect.assertions(2);

        answer({ quote: "I work as a nurse" });
        renderItem({});
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("“I work as a nurse”")).toBeDefined();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("shows nothing from before once the row is closed and opened again, while access is checked afresh", async () => {
        expect.assertions(5);

        answer({ messageId: "message-1", quote: "I work as a nurse", threadId: "thread-1" });
        renderItem({});
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("“I work as a nurse”")).toBeDefined();

        // The row drops an unobserved query on its own gcTime, which is far shorter than the query client's default:
        // running only the timers already pending would also fire the default and hide a removed gcTime.
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));
        // The chat was locked meanwhile; the fresh check has not answered yet.
        harness.respond = () => new Promise<Source>(() => {});
        await vi.advanceTimersByTimeAsync(1000);
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(harness.requests).toBe(2);
        expect(screen.getByRole("status").textContent).toBe("Loading…");
        expect(screen.queryByText("“I work as a nurse”")).toBeNull();
        expect(screen.queryByRole("link")).toBeNull();
    });

    it("says the quote is hidden, not missing, while its chat is locked", async () => {
        expect.assertions(2);

        answer({ quoteHidden: true });
        renderItem({});
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("The quote stays hidden while you can't open its chat.")).toBeDefined();
        expect(screen.queryByText("No quote was kept for this memory.")).toBeNull();
    });

    it.each([
        ["learned without one", false],
        // Rewritten in another tab: the list still says it has one, the backend knows it has not.
        ["rewritten since the list loaded", true],
    ])("says no quote was kept for a memory %s", async (_case, hasEvidence) => {
        expect.assertions(1);

        answer({ threadId: "thread-1" });
        renderItem({ hasEvidence });
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("No quote was kept for this memory.")).toBeDefined();
    });

    it("announces that the source is loading", () => {
        expect.assertions(1);

        harness.respond = () => new Promise<Source>(() => {});
        renderItem({});
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(screen.getByRole("status").textContent).toBe("Loading…");
    });

    it("says so when the source could not be loaded", async () => {
        expect.assertions(1);

        harness.respond = () => Promise.reject(new Error("offline"));
        renderItem({});
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        await waitFor(() => {
            expect(screen.getByRole("alert").textContent).toBe("Could not load where this memory came from.");
        });
    });

    it("offers no source for a memory the user wrote", () => {
        expect.assertions(1);

        renderItem({ hasEvidence: false, source: "manual" });

        expect(screen.queryByRole("button", { name: WHY_RE })).toBeNull();
    });

    it("shows the words a later statement backed a rewritten memory with", async () => {
        expect.assertions(1);

        answer({ quote: "I moved to Berlin" });
        renderItem({ hasEvidence: true, source: "manual" });
        fireEvent.click(screen.getByRole("button", { name: WHY_RE }));

        expect(await screen.findByText("“I moved to Berlin”")).toBeDefined();
    });
});

describe("memory item dates", () => {
    it("shows an event's range and the day a fact ends", () => {
        renderMemory({ ...dated, eventEnd: "2026-11-22", eventStart: "2026-11-20", validUntil: "2026-11-22" });

        expect(screen.getByText("Nov 20, 2026 – Nov 22, 2026").textContent).toBeTruthy();
        expect(screen.getByText("Until Nov 22, 2026").textContent).toBeTruthy();
    });

    it("shows a single event day", () => {
        renderMemory({ ...dated, eventStart: "2026-11-01" });

        expect(screen.getByText("On Nov 1, 2026").textContent).toBeTruthy();
    });
});

describe("editing a memory's dates", () => {
    it("clears a wrong end date and saves all three dates as the person left them", () => {
        const saved = vi.fn();

        renderMemory({ ...dated, eventStart: "2026-11-20", validUntil: "2026-11-22" }, saved);

        fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
        fireEvent.change(screen.getByLabelText("Holds until"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(saved).toHaveBeenCalledWith("m1", { dates: { eventEnd: "", eventStart: "2026-11-20", validUntil: "" } });
    });

    it("refuses an event that ends before it starts", () => {
        const saved = vi.fn();

        renderMemory({ ...dated, eventStart: "2026-11-20" }, saved);

        fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
        fireEvent.change(screen.getByLabelText("Event ends on"), { target: { value: "2026-11-19" } });

        expect(screen.getByRole("alert").textContent).toBe("An event cannot end before it starts.");
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
        expect(saved).not.toHaveBeenCalled();
    });
});
