import type { ToolPart } from "@neore/chat-ui/types";
import { focusManager, QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HumanCheckCard } from "./browser-human-check";
import { onBrowserControlRequest } from "./control-request";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

/** The signed-in account the card reads; a case switches it. */
const signedIn = vi.hoisted(() => {
    return { userId: "user-a" };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: { user: { id: signedIn.userId } } };
        },
    };
});

const { backend } = vi.hoisted(() => {
    return {
        backend: {
            answerFails: false,
            /** While set, a save waits for it. */
            answerHeld: undefined as Promise<void> | undefined,
            checkFails: false,
            answers: [] as unknown[],
            browser: null as Record<string, unknown> | null,
            check: null as Record<string, unknown> | null,
            /** Per ask id, its answer in place of `check`. */
            checksById: new Map<string, Record<string, unknown> | null>(),
            checkReads: 0,
            /** While set, every read waits for it. */
            readsHeld: undefined as Promise<void> | undefined,
            /** While set, a read past a subscription answers what the server said when it was sent, once it is released. */
            sampledHeld: undefined as Promise<void> | undefined,
            /** Reads past the subscriptions, per query name. */
            oneOffReads: { getHumanCheck: 0, getThreadBrowser: 0 },
            fail: false,
            /** Only the live subscription of the ask fails; a read past it answers. */
            liveCheckFails: false,
            /** Only the live subscription of the status fails; a read past it answers. */
            liveStatusFails: false,
            /** A live query's refetch answers its subscription's last push, not the server's answer now. */
            live: new Map<string, unknown>(),
            pushesOnly: false,
        },
    };
});

/**
 * An answer as the server sends it: `null` stands for one without a browser or an ask the caller reads (`kind: "none"`),
 * which carries only the server's clock, here the device's.
 */
const wire = (value: unknown): unknown => (value === null ? { kind: "none", now: Date.now() } : value);

/** The status of a caller who does not read the chat now (a grant that ended): only the server's clock. */
const denied = (now = Date.now()) => {
    return { kind: "denied", now };
};

/** A query as `crpc` builds it: live by default (see `backend.pushesOnly`), a plain read with `{ live: false }`. */
const queryOf = (name: string, read: (args: Record<string, unknown>) => unknown) => (args: unknown, options?: { live?: boolean }) => {
    if (args === skipToken) {
        return { queryFn: skipToken, queryKey: [name, "skipped"] };
    }

    const key = JSON.stringify(args);

    return {
        queryFn: async () => {
            await backend.readsHeld;

            if (options?.live === false) {
                backend.oneOffReads[name as keyof typeof backend.oneOffReads] += 1;
            } else if (name === "getHumanCheck" ? backend.liveCheckFails : backend.liveStatusFails) {
                throw new Error("subscription failed");
            }

            if (options?.live !== false && backend.pushesOnly && backend.live.has(`${name}:${key}`)) {
                return backend.live.get(`${name}:${key}`);
            }

            const value = wire(read(args as Record<string, unknown>));

            if (options?.live === false) {
                await backend.sampledHeld;
            }

            if (options?.live !== false) {
                backend.live.set(`${name}:${key}`, value);
            }

            return value;
        },
        queryKey: [name, args],
        // As `lunoraQueryOptions`: a live query is never stale, so focus does not refetch it.
        ...(options?.live !== false && { staleTime: Infinity }),
    };
};

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                browser: {
                    human_check_card: {
                        getHumanCheck: {
                            queryOptions: queryOf("getHumanCheck", (args: Record<string, unknown>) => {
                                backend.checkReads += 1;

                                if (backend.checkFails) {
                                    throw new Error("check unavailable");
                                }

                                const { checkId } = args;

                                return typeof checkId === "string" && backend.checksById.has(checkId) ? backend.checksById.get(checkId) : backend.check;
                            }),
                        },
                        resolveHumanCheck: {
                            mutationOptions: () => {
                                return {
                                    mutationFn: async (args: { resolution: string }) => {
                                        backend.answers.push(args);
                                        await backend.answerHeld;

                                        if (backend.answerFails) {
                                            throw new Error("answer refused");
                                        }

                                        return { changed: true, status: args.resolution };
                                    },
                                };
                            },
                        },
                    },
                    live_view: {
                        getThreadBrowser: {
                            queryOptions: queryOf("getThreadBrowser", () => {
                                if (backend.fail) {
                                    throw new Error("status unavailable");
                                }

                                return backend.browser;
                            }),
                        },
                    },
                },
            };
        },
    };
});

/** The window loses and regains focus, which refetches what is stale. */
const refocus = async (): Promise<void> => {
    await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
    });
};

/** The server pushes `value` to the live query `name` of the thread's card. */
const push = async (client: QueryClient, name: string, args: unknown, value: unknown): Promise<void> => {
    backend.live.set(`${name}:${JSON.stringify(args)}`, wire(value));
    await client.invalidateQueries({ exact: true, queryKey: [name, args] });
};

/** The query client hands each new answer to the card on a later task: an assertion that nothing changed waits for it. */
const settle = async (): Promise<void> => {
    await act(async () => {
        await new Promise((resolve: (value: unknown) => void) => {
            setTimeout(resolve, 0);
        });
    });
};

/** The card's words when no picture of the page came with the ask. */
const NO_PICTURE = /No picture of the page could be taken/u;

/** The hint that names Take control. */
const TAKE_CONTROL_HINT = /Take control, clear it/u;

/** The card's wording when it names the site. */
const SITE_NAMED = /a page on shop\.example\.com only a person can clear/u;

/** The card's words for a browser that has closed. */
const BROWSER_CLOSED = /The browser has closed/u;

/** The note of an ask marked done elsewhere. */
const MARKED_DONE = /This check was marked done/u;

/** A card the test renders again, for another ask, under one query client. */
const reusedCard = (client: QueryClient) => (part: ToolPart, threadId: string) => (
    <QueryClientProvider client={client}>
        <HumanCheckCard liveViewHere part={part} threadId={threadId} />
    </QueryClientProvider>
);

/** The card's words when its ask could not be read. */
const CHECK_UNREAD = /Whether this check is still open could not be checked/u;

/** Each change of what a reused card is for: its chat, site, reply or ask. */
const REUSES: [string, { threadId?: string }, Record<string, string>][] = [
    ["chat", { threadId: "thread-2" }, {}],
    ["site", {}, { site: "other.example.com" }],
    ["reply", {}, { run: "run-2" }],
    ["ask", {}, { checkId: "check-2" }],
];

/** The site's name anywhere in the card. */
const SITE_NAME = /shop\.example\.com/u;

const PART = {
    output: {
        humanCheck: { browserId: "b-1", site: "shop.example.com", status: "asked" },
        screenshot: "aGVsbG8=",
        screenshotFormat: "jpeg",
        success: false,
        url: "https://shop.example.com/item",
    },
    state: "output-available",
    toolCallId: "call-1",
    type: "tool-browser",
} as unknown as ToolPart;

const running = (overrides: Record<string, unknown> = {}) => {
    return {
        browserId: "b-1",
        canControl: true,
        currentUrl: "https://shop.example.com/item",
        idleUntil: Date.now() + 60_000,
        kind: "running",
        now: Date.now(),
        ...overrides,
    };
};

const show = (part: ToolPart = PART, liveViewHere = true) =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <HumanCheckCard liveViewHere={liveViewHere} part={part} threadId="thread-1" />
        </QueryClientProvider>,
    );

// A clock that runs by its reads, not by the wall: each read of the time is one millisecond after the one before, so an
// answer stamped `Date.now()` (a `none` read, `denied()`) lands after every earlier one and before a case's offsets in
// seconds, however slow the run. A case that waits out a deadline moves the clock itself (`useFakeTimers`).
beforeEach(() => {
    let clock = Date.UTC(2026, 10, 24, 12);

    vi.spyOn(Date, "now").mockImplementation(() => {
        clock += 1;

        return clock;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    signedIn.userId = "user-a";
    backend.answerFails = false;
    backend.answerHeld = undefined;
    backend.checkFails = false;
    backend.answers = [];
    backend.browser = null;
    backend.check = null;
    backend.checksById.clear();
    backend.checkReads = 0;
    backend.readsHeld = undefined;
    backend.sampledHeld = undefined;
    backend.oneOffReads = { getHumanCheck: 0, getThreadBrowser: 0 };
    backend.fail = false;
    backend.liveCheckFails = false;
    backend.liveStatusFails = false;
    backend.live.clear();
    backend.pushesOnly = false;
});

/** The ask as the card reads it, named by the result (`checkId`). */
const ASKED = {
    ...PART,
    output: { ...(PART.output as object), humanCheck: { browserId: "b-1", checkId: "check-1", run: "run-1", site: "shop.example.com", status: "asked" } },
} as unknown as ToolPart;

const openCheck = (overrides: Record<string, unknown> = {}) => {
    return { canResolve: true, expiresAt: Date.now() + 3_600_000, kind: "found", now: Date.now(), site: "shop.example.com", status: "open", ...overrides };
};

describe("the Needs you card's answer", () => {
    it.each([
        ["done", "Mark done", "You marked this check done."],
        ["declined", "Decline", "You declined this check."],
    ])("sends %s once, then says so and offers neither answer nor Take control", async (resolution, button, text) => {
        backend.browser = running();
        backend.check = openCheck();
        show(ASKED);

        await userEvent.click(await screen.findByRole("button", { name: button }));

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain(text);
        });
        expect(backend.answers).toEqual([{ checkId: "check-1", resolution, run: "run-1", site: "shop.example.com", threadId: "thread-1" }]);
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it("never tells the account signed in after a switch that it gave the answer the last one sent", async () => {
        let release = (): void => {};

        backend.browser = running();
        backend.check = openCheck();
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        backend.answerHeld = new Promise<void>((resolve: () => void) => {
            release = resolve;
        });

        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const card = reusedCard(client);
        const { rerender } = render(card(ASKED, "thread-1"));

        await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));

        // Another account signs in while the first one's answer is still saving (a switch clears the query cache); the
        // save then completes.
        signedIn.userId = "user-b";
        backend.check = openCheck({ canResolve: false, status: "done" });
        backend.live.clear();
        client.clear();
        rerender(card(ASKED, "thread-1"));
        await act(async () => {
            release();
        });

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("This check was marked done.");
        });
        expect(screen.getByRole("status").textContent).not.toContain("You marked");
    });

    it("shows an answer given elsewhere without saying the viewer gave it", async () => {
        backend.browser = running();
        backend.check = openCheck({ canResolve: false, status: "declined" });
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("This check was declined.");
        });
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    });

    it("offers no answer to someone who may not give one, and still shows why they cannot take control", async () => {
        backend.browser = running({ canControl: false });
        backend.check = openCheck({ canResolve: false });
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Only someone who can write in this chat");
        });
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    });

    it("offers no answer on an older result that names no ask", async () => {
        backend.browser = running();
        backend.check = openCheck();
        show();

        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    });

    it("reads no ask and shows no error for a grantee's result from before asks carried their reply", async () => {
        // A grantee's status is also read past the subscription; the ask, which the result cannot name, is never read.
        backend.browser = running({ accessUntil: Date.now() + 600_000 });
        backend.check = openCheck();
        const output = ASKED.output as { humanCheck: Record<string, unknown> };

        show({ ...ASKED, output: { ...output, humanCheck: { ...output.humanCheck, run: undefined } } } as unknown as ToolPart);

        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
        await settle();
        expect(backend.checkReads).toBe(0);
        expect(screen.getByRole("status").textContent).toBe("");
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("says an answer that could not be saved can be sent again", async () => {
        backend.browser = running();
        backend.check = openCheck();
        backend.answerFails = true;
        show(ASKED);

        await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Your answer could not be saved.");
        });
        expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
    });

    it("offers no answer once a later read of the ask fails, but still Take control, until a read succeeds", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

        backend.checkFails = true;
        await client.invalidateQueries({ queryKey: ["getHumanCheck"] });

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Whether this check is still open could not be checked.");
        });
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();

        backend.checkFails = false;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
    });

    it("offers no answer once the ask's subscription fails, though it recovers with its last push and the read past it fails, until a newer answer", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const askArgs = { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" };
        const askedAt = Date.now();

        backend.pushesOnly = true;
        backend.browser = running();
        backend.check = openCheck({ now: askedAt });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

        backend.liveCheckFails = true;
        await client.invalidateQueries({ exact: true, queryKey: ["getHumanCheck", askArgs] });

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Whether this check is still open could not be checked.");
        });

        // The subscription comes back and answers its last push again: nothing newer than the failure. The one read past
        // it fails too.
        const readsBefore = backend.oneOffReads.getHumanCheck;

        backend.checkFails = true;
        backend.liveCheckFails = false;
        await client.invalidateQueries({ exact: true, queryKey: ["getHumanCheck", askArgs] });
        await settle();

        expect(backend.oneOffReads.getHumanCheck).toBe(readsBefore + 1);
        expect(screen.getByRole("status").textContent).toContain("Whether this check is still open could not be checked.");
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();

        await push(client, "getHumanCheck", askArgs, openCheck({ now: askedAt + 1000 }));

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
    });

    it("reads the ask once past its subscription when it recovers, and offers the answers again on what that read says", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const askArgs = { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" };

        backend.pushesOnly = true;
        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

        backend.liveCheckFails = true;
        await client.invalidateQueries({ exact: true, queryKey: ["getHumanCheck", askArgs] });
        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Whether this check is still open could not be checked.");
        });

        const readsBefore = backend.oneOffReads.getHumanCheck;

        backend.liveCheckFails = false;
        await client.invalidateQueries({ exact: true, queryKey: ["getHumanCheck", askArgs] });

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        await settle();
        expect(backend.oneOffReads.getHumanCheck).toBe(readsBefore + 1);
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("reads the status once past its subscription when it recovers; a failing read keeps the failure, and Try again still reads", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const statusArgs = { threadId: "thread-1" };
        const outage = async (): Promise<void> => {
            backend.liveStatusFails = true;
            await client.invalidateQueries({ exact: true, queryKey: ["getThreadBrowser", statusArgs] });
            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toBe("Whether the browser is still open could not be checked.");
            });
            expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        };

        backend.pushesOnly = true;
        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

        await outage();
        let readsBefore = backend.oneOffReads.getThreadBrowser;

        backend.liveStatusFails = false;
        await client.invalidateQueries({ exact: true, queryKey: ["getThreadBrowser", statusArgs] });

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
        await settle();
        expect(backend.oneOffReads.getThreadBrowser).toBe(readsBefore + 1);

        // Again, and the read past the subscription fails this time: the replay alone clears nothing.
        await outage();
        readsBefore = backend.oneOffReads.getThreadBrowser;
        backend.fail = true;
        backend.liveStatusFails = false;
        await client.invalidateQueries({ exact: true, queryKey: ["getThreadBrowser", statusArgs] });
        await settle();

        expect(backend.oneOffReads.getThreadBrowser).toBe(readsBefore + 1);
        expect(screen.getByRole("status").textContent).toBe("Whether the browser is still open could not be checked.");
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();

        backend.fail = false;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
    });

    it("offers no answer, site or page while the browser's status could not be read, and can read it again", async () => {
        backend.browser = running();
        backend.fail = true;
        backend.check = openCheck();
        show(ASKED);

        expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
        expect(screen.getByRole("status").textContent).toContain("Whether the browser is still open could not be checked.");
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByText(SITE_NAME)).toBeNull();
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("shows no site, page or button when the ask the result names cannot be read", async () => {
        backend.browser = running();
        backend.check = null;
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This check can no longer be read here.");
        });
        expect(screen.queryByText(SITE_NAME)).toBeNull();
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.queryAllByRole("button")).toEqual([]);
    });

    it.each([
        ["running", () => running(), TAKE_CONTROL_HINT],
        ["none", () => null, BROWSER_CLOSED],
    ])("keeps the site and page of an ask of another chat, as in a branch, while the status is %s, and offers no answer", async (_kind, status, said) => {
        backend.browser = status();
        backend.check = { kind: "elsewhere", now: Date.now() };
        show(ASKED);

        expect(await screen.findByText(said)).toBeTruthy();
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
        expect(screen.getByRole("img")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    });

    it("says an ask of another chat cannot be answered here when the browser says nothing else", async () => {
        backend.browser = running();
        backend.check = { kind: "elsewhere", now: Date.now() };
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This check cannot be answered in this chat.");
        });
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
    });

    it("closes an unanswered ask once it expires, without a new answer from the server", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            backend.browser = running();
            backend.check = openCheck({ expiresAt: Date.now() + 10_000 });
            show(ASKED);

            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("status").textContent).toContain("This check is no longer open.");
            expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the Needs you card's live read of the ask", () => {
    /** Whether the card still observes the ask's live query: a disabled one holds no subscription. */
    const liveAsk = (client: QueryClient) =>
        client
            .getQueryCache()
            .find({ exact: true, queryKey: ["getHumanCheck", { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" }] });

    it.each([
        ["answered", () => openCheck({ canResolve: false, status: "done" })],
        ["expired", () => openCheck({ canResolve: false, status: "expired" })],
        [
            "of another chat",
            () => {
                return { kind: "elsewhere", now: Date.now() };
            },
        ],
    ])("lets go of an ask %s, which can change no more, and keeps what it shows", async (_state, answer) => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running();
        backend.check = answer();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(liveAsk(client)?.isActive()).toBe(false);
        });
        expect(liveAsk(client)?.state.data).toMatchObject({ kind: answer().kind });
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    });

    it("still hides an answered ask's site and page once the status says the chat is no longer read (trashed, locked)", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.pushesOnly = true;
        backend.browser = running();
        backend.check = openCheck({ canResolve: false, status: "done" });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(liveAsk(client)?.isActive()).toBe(false);
        });
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();

        await push(client, "getThreadBrowser", { threadId: "thread-1" }, denied(Date.now() + 1000));

        await waitFor(() => {
            expect(screen.queryByText(SITE_NAME)).toBeNull();
        });
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("keeps an open ask live, and lets go once it is answered", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.pushesOnly = true;
        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(liveAsk(client)?.isActive()).toBe(true);

        await push(
            client,
            "getHumanCheck",
            { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" },
            openCheck({ canResolve: false, status: "declined" }),
        );

        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        });
        expect(liveAsk(client)?.isActive()).toBe(false);
    });

    it("keeps an ask it showed lapsed lapsed, though an open answer sent before its end arrives later", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const askArgs = { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" };
            const askedAt = Date.now();
            const expiresAt = askedAt + 5000;

            backend.pushesOnly = true;
            backend.browser = running();
            backend.check = openCheck({ expiresAt, now: askedAt });
            render(
                <QueryClientProvider client={client}>
                    <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
                </QueryClientProvider>,
            );
            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5050);
            });
            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();

            // Sent 3 s before the end, later than the first answer, delivered just after the end: on its own clock the end
            // is 3 s ahead, so the new clock sample moves the deadline on this device past now.
            await push(client, "getHumanCheck", askArgs, openCheck({ expiresAt, now: askedAt + 2000 }));
            await settle();

            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
            expect(screen.getByRole("status").textContent).toContain("This check is no longer open.");
        } finally {
            vi.useRealTimers();
        }
    });

    it("lets go of an ask its timer saw lapse, and reads it once past the subscription", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

            backend.pushesOnly = true;
            backend.browser = running();
            backend.check = openCheck({ expiresAt: Date.now() + 5000 });
            render(
                <QueryClientProvider client={client}>
                    <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
                </QueryClientProvider>,
            );
            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
            expect(liveAsk(client)?.isActive()).toBe(true);

            const readsBefore = backend.oneOffReads.getHumanCheck;

            // The server still says open (it pushes nothing when an ask runs out).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5050);
            });

            await waitFor(() => {
                expect(liveAsk(client)?.isActive()).toBe(false);
            });
            expect(backend.oneOffReads.getHumanCheck).toBe(readsBefore + 1);
            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
            expect(screen.getByRole("status").textContent).toContain("This check is no longer open.");
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(REUSES)(
        "reads an open ask live again when the card is reused for another %s",
        async (_change, props: { threadId?: string }, ask: Record<string, string>) => {
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const card = reusedCard(client);

            backend.browser = running();
            backend.check = openCheck({ canResolve: false, status: "done" });

            const { rerender } = render(card(ASKED, "thread-1"));

            await waitFor(() => {
                expect(liveAsk(client)?.isActive()).toBe(false);
            });

            backend.check = openCheck();

            const humanCheck = { ...(ASKED.output as { humanCheck: Record<string, string> }).humanCheck, ...ask };
            const threadId = props.threadId ?? "thread-1";

            rerender(card({ ...ASKED, output: { ...(ASKED.output as object), humanCheck } } as unknown as ToolPart, threadId));

            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
            const askArgs = { checkId: humanCheck.checkId, run: humanCheck.run, site: humanCheck.site, threadId };

            expect(
                client
                    .getQueryCache()
                    .find({ exact: true, queryKey: ["getHumanCheck", askArgs] })
                    ?.isActive(),
            ).toBe(true);
        },
    );

    it.each(REUSES)(
        "shows no read failure of the last ask when the card is reused for another %s",
        async (_change, props: { threadId?: string }, ask: Record<string, string>) => {
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const card = reusedCard(client);

            backend.browser = running();
            backend.checkFails = true;

            const { rerender } = render(card(ASKED, "thread-1"));

            expect(await screen.findByText(CHECK_UNREAD)).toBeTruthy();

            backend.checkFails = false;
            backend.check = openCheck();

            const humanCheck = { ...(ASKED.output as { humanCheck: Record<string, string> }).humanCheck, ...ask };

            rerender(card({ ...ASKED, output: { ...(ASKED.output as object), humanCheck } } as unknown as ToolPart, props.threadId ?? "thread-1"));

            // Before the new ask has answered too: its card holds nothing of the last one's reads.
            expect(screen.queryByText(CHECK_UNREAD)).toBeNull();
            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
            expect(screen.queryByText(CHECK_UNREAD)).toBeNull();
        },
    );
});

describe("the Needs you card once a grantee's grant ends", () => {
    it("stops showing the site, its page and the answers at the grant's end on the server's clock, and reads again", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            // The device runs 20 s behind the server: the grant ends 10 s after the read on the server's clock.
            const serverNow = Date.now() + 20_000;

            backend.browser = running({ now: serverNow });
            backend.check = openCheck({ accessUntil: serverNow + 10_000, now: serverNow });
            show(ASKED);

            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();

            // Past the grant's end the server answers nothing.
            backend.browser = denied();
            backend.check = null;
            const readsBefore = backend.checkReads;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("status").textContent).toBe("Your access to this chat has ended.");
            expect(screen.queryByText(SITE_NAME)).toBeNull();
            expect(screen.queryByRole("img")).toBeNull();
            expect(screen.queryByText(NO_PICTURE)).toBeNull();
            expect(screen.queryAllByRole("button")).toEqual([]);
            expect(backend.checkReads).toBeGreaterThan(readsBefore);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the site and the answers up to the grant's end on the server's clock, not the device's", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            // The server runs 20 s behind the device: by the device's clock the grant ended already, by the server's it has 10 s.
            const serverNow = Date.now() - 20_000;

            backend.browser = running({ now: serverNow });
            backend.check = openCheck({ accessUntil: serverNow + 10_000, expiresAt: serverNow + 3_600_000, now: serverNow });
            show(ASKED);

            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(5000);
            });
            expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(6000);
            });
            expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
            expect(screen.queryByText(SITE_NAMED)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("moves focus to the status when the answers go at the grant's end while one held it", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            backend.browser = running();
            backend.check = openCheck({ accessUntil: Date.now() + 10_000 });
            show(ASKED);

            const decline = await screen.findByRole("button", { name: "Decline" });

            decline.focus();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
            expect(screen.getByRole("status").matches(":focus")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads past the subscription only the open ask of a long chat when the window regains focus, and the status once", async () => {
        const until = Date.now() + 600_000;
        const askedAs = (checkId: string): ToolPart =>
            ({
                ...PART,
                output: {
                    ...(PART.output as object),
                    humanCheck: { browserId: "b-1", checkId, run: `run-${checkId}`, site: "shop.example.com", status: "asked" },
                },
                toolCallId: `call-${checkId}`,
            }) as unknown as ToolPart;
        const past = ["past-1", "past-2", "past-3", "past-4"];

        backend.browser = running({ accessUntil: until });
        backend.check = openCheck({ accessUntil: until });

        for (const checkId of past) {
            backend.checksById.set(checkId, openCheck({ accessUntil: until, status: "done" }));
        }

        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                {[...past, "open-1"].map((checkId: string) => (
                    <HumanCheckCard key={checkId} liveViewHere part={askedAs(checkId)} threadId="thread-1" />
                ))}
            </QueryClientProvider>,
        );

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        await waitFor(() => {
            expect(screen.getAllByText(MARKED_DONE)).toHaveLength(past.length);
        });
        await settle();
        // On mount too, only the open ask was read past its subscription.
        expect(backend.oneOffReads.getHumanCheck).toBe(1);

        backend.oneOffReads = { getHumanCheck: 0, getThreadBrowser: 0 };
        await refocus();
        await settle();

        expect(backend.oneOffReads).toStrictEqual({ getHumanCheck: 1, getThreadBrowser: 1 });
        expect(screen.getAllByRole("button", { name: "Mark done" })).toHaveLength(1);
    });

    it("shows the card again when the read past the subscription at the grant's end answers with a renewed grant", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const readAt = Date.now();

            // Live reads answer their last push: a renewed grant (a `.global()` write) pushes nothing.
            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            backend.check = openCheck({ accessUntil: readAt + 10_000, now: readAt });
            show(ASKED);
            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

            // The owner renewed the grant before it ran out; the reads at its end answer after it.
            backend.browser = running({ accessUntil: readAt + 600_000, now: readAt + 10_500 });
            backend.check = openCheck({ accessUntil: readAt + 600_000, now: readAt + 10_500 });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();
            expect(screen.getByRole("status").textContent).toBe("");
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads the status once more when the read at the grant's end joined one sent before it, and shows the renewed grant", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const readAt = Date.now();

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            show();
            expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();

            // A read sent before the end (on focus) answers late, with what the server said then: the grant not yet renewed.
            let release = (): void => undefined;

            // The tsconfig lib predates `Promise.withResolvers`.
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
            backend.sampledHeld = new Promise<void>((resolve: () => void) => {
                release = resolve;
            });
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt + 9000 });
            await refocus();

            // The owner renews the grant; the card's read at the end joins the one still out.
            backend.browser = running({ accessUntil: readAt + 600_000, now: readAt + 10_500 });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            expect(screen.getByRole("status").textContent).toBe("Your access to this chat has ended.");
            expect(screen.queryByText(SITE_NAME)).toBeNull();

            const readsBefore = backend.oneOffReads.getThreadBrowser;

            backend.sampledHeld = undefined;
            release();

            expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();
            expect(backend.oneOffReads.getThreadBrowser).toBeGreaterThan(readsBefore);
        } finally {
            vi.useRealTimers();
        }
    });

    it("shows a card with no ask id again when the window regains focus after the grant was renewed", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const readAt = Date.now();

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            show();
            expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();

            backend.browser = denied();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            expect(screen.getByRole("status").textContent).toBe("Your access to this chat has ended.");

            backend.browser = running({ accessUntil: Date.now() + 600_000, now: Date.now() });
            await refocus();

            expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads the ask again when a browser status shows the renewed grant, though the ask pushed nothing", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        try {
            const readAt = Date.now();

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            backend.check = openCheck({ accessUntil: readAt + 10_000, now: readAt });
            render(
                <QueryClientProvider client={client}>
                    <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
                </QueryClientProvider>,
            );
            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

            // Past the grant's end the server answers nothing, to the reads past the subscriptions too.
            backend.browser = denied();
            backend.check = null;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            expect(screen.getByRole("status").textContent).toBe("Your access to this chat has ended.");

            // Renewed a while later; the agent acts in the browser, so its status pushes. The ask's row is not written.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1000);
            });
            backend.browser = running({ accessUntil: Date.now() + 600_000, now: Date.now() });
            backend.check = openCheck({ accessUntil: Date.now() + 600_000, now: Date.now() });
            await push(client, "getThreadBrowser", { threadId: "thread-1" }, backend.browser);

            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("stays hidden after a removal though reads past the subscriptions, from a copy of the grant that has not seen it, answer later", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const readAt = Date.now();
        const status = { threadId: "thread-1" };
        const ask = { checkId: "check-1", run: "run-1", site: "shop.example.com", threadId: "thread-1" };

        backend.pushesOnly = true;
        backend.browser = running({ accessUntil: readAt + 3_600_000, now: readAt, revision: 1 });
        backend.check = openCheck({ accessUntil: readAt + 3_600_000, now: readAt, revision: 1 });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();

        // A copy of the grant that has not seen the removal answers the reads past the subscriptions on a later server
        // clock than the removal's pushes, with the grant's older revision.
        backend.browser = running({ accessUntil: readAt + 3_600_000, now: readAt + 5000, revision: 1 });
        backend.check = openCheck({ accessUntil: readAt + 3_600_000, now: readAt + 5000, revision: 1 });
        await push(client, "getThreadBrowser", status, { ...denied(readAt + 1000), revision: 2 });
        await push(client, "getHumanCheck", ask, { kind: "none", now: readAt + 1000, revision: 2 });
        await refocus();
        await settle();

        expect(backend.oneOffReads.getThreadBrowser).toBeGreaterThan(0);
        expect(screen.queryByText(SITE_NAME)).toBeNull();
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();

        // A renewal pushes nothing but advances the revision: the reads past the subscriptions show the card again.
        backend.browser = running({ accessUntil: readAt + 7_200_000, now: readAt + 6000, revision: 3 });
        backend.check = openCheck({ accessUntil: readAt + 7_200_000, now: readAt + 6000, revision: 3 });
        await refocus();

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
    });

    it.each([
        ["an answered ask keeps its answer", { canResolve: false, status: "declined" }, "This check was declined."],
        ["an open ask keeps its answers", {}, undefined],
    ])("reads the ask again when a status names a newer grant revision without an end in sight: %s", async (_case, overrides, note) => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const readAt = Date.now();

        backend.pushesOnly = true;
        backend.browser = running({ now: readAt, revision: 1 });
        backend.check = openCheck({ now: readAt, revision: 1, ...overrides });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        await screen.findByText(SITE_NAMED);

        // The owner changed the grant (a permission or a renewal): the status's next push names the new revision; the
        // ask's row is not written, so its subscription pushes nothing.
        backend.browser = running({ now: readAt + 1000, revision: 2 });
        backend.check = openCheck({ now: readAt + 1000, revision: 2, ...overrides });
        await push(client, "getThreadBrowser", { threadId: "thread-1" }, backend.browser);

        await waitFor(() => {
            expect(backend.oneOffReads.getHumanCheck).toBe(1);
        });

        if (note === undefined) {
            expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
            expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
        } else {
            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toContain(note);
            });
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        }
    });

    it("shows a card that mounted after the grant ended once the window regains focus after a renewal", async () => {
        backend.pushesOnly = true;
        backend.browser = denied();
        backend.check = null;
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This check can no longer be read here.");
        });

        backend.browser = running({ accessUntil: Date.now() + 600_000 });
        backend.check = openCheck({ accessUntil: Date.now() + 600_000 });
        await refocus();

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
    });

    it("keeps reading an open ask on focus while its copy of the grant says the caller does not read it, until it does", async () => {
        const readAt = Date.now();

        backend.pushesOnly = true;
        backend.browser = denied(readAt);
        backend.check = null;
        show(ASKED);
        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This check can no longer be read here.");
        });

        // Renewed: the status's copy of the grant has it, the ask's not yet.
        backend.browser = running({ accessUntil: readAt + 600_000, now: readAt + 1000 });
        await refocus();
        await settle();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();

        backend.check = openCheck({ accessUntil: readAt + 600_000, now: readAt + 2000 });
        await refocus();

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
    });

    it("shows an answered ask's site again after its grant was renewed, reading that ask once at the old end", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const readAt = Date.now();

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            backend.check = openCheck({ accessUntil: readAt + 10_000, now: readAt, status: "done" });
            show(ASKED);
            expect(await screen.findByText(MARKED_DONE)).toBeTruthy();
            expect(screen.getByText(SITE_NAMED)).toBeTruthy();

            // The live reads keep their last push, which names the old end; the reads past them see the renewal.
            backend.browser = running({ accessUntil: readAt + 600_000, now: readAt + 10_500 });
            backend.check = openCheck({ accessUntil: readAt + 600_000, now: readAt + 10_500, status: "done" });
            const readsBefore = backend.oneOffReads.getHumanCheck;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(await screen.findByText(SITE_NAMED)).toBeTruthy();
            expect(screen.getByText(MARKED_DONE)).toBeTruthy();
            expect(backend.oneOffReads.getHumanCheck).toBe(readsBefore + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("reads an answered ask again on focus while it is the read behind, after its read at the old end failed", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const readAt = Date.now();

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil: readAt + 10_000, now: readAt });
            backend.check = openCheck({ accessUntil: readAt + 10_000, now: readAt, status: "done" });
            show(ASKED);
            expect(await screen.findByText(MARKED_DONE)).toBeTruthy();

            // The status's read past the subscription sees the renewal; the ask's fails, so the ask is the read behind.
            backend.browser = running({ accessUntil: readAt + 600_000, now: readAt + 10_500 });
            backend.check = openCheck({ accessUntil: readAt + 600_000, now: readAt + 10_500, status: "done" });
            backend.checkFails = true;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            await vi.waitFor(() => {
                expect(backend.oneOffReads.getHumanCheck).toBe(1);
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(screen.queryByText(SITE_NAMED)).toBeNull();

            backend.checkFails = false;
            await refocus();

            expect(await screen.findByText(SITE_NAMED)).toBeTruthy();
            expect(screen.getByText(MARKED_DONE)).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it("ends at the grant's end once a later status says the browser closed, as that status names the end too", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            const readAt = Date.now();
            const accessUntil = readAt + 10_000;

            backend.pushesOnly = true;
            backend.browser = running({ accessUntil, now: readAt });
            backend.check = openCheck({ accessUntil, now: readAt });
            render(
                <QueryClientProvider client={client}>
                    <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
                </QueryClientProvider>,
            );
            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();

            // The browser closes (a minute after its last action): the status, now newer than the ask's read, has no browser.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });
            await push(client, "getThreadBrowser", { threadId: "thread-1" }, { accessUntil, kind: "none", now: Date.now() });
            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toMatch(BROWSER_CLOSED);
            });

            backend.browser = denied();
            backend.check = null;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(9000);
            });

            expect(screen.getByRole("status").textContent).toBe("Your access to this chat has ended.");
            expect(screen.queryByText(SITE_NAME)).toBeNull();
            expect(screen.queryByRole("img")).toBeNull();
            expect(screen.queryAllByRole("button")).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the Needs you card", () => {
    it("shows no site, page or button while its reads have not answered, as on an account switch", async () => {
        let release = (): void => {};

        backend.browser = running();
        backend.check = openCheck();
        // Both reads stay out: the card is on screen before the server has said whether the caller reads the chat. The
        // tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        backend.readsHeld = new Promise<void>((resolve: () => void) => {
            release = resolve;
        });
        show(ASKED);
        await settle();

        expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe("Loading this check…");
        expect(screen.queryByText(SITE_NAME)).toBeNull();
        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.queryByText(NO_PICTURE)).toBeNull();
        expect(screen.queryByRole("button")).toBeNull();

        release();

        expect(await screen.findByText(SITE_NAMED)).toBeTruthy();
        expect(screen.getByRole("img", { name: "What the agent's browser sees on shop.example.com" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
    });

    it("names the site, shows what the browser sees, and asks the live view card for control", async () => {
        backend.browser = running();
        const asked: string[] = [];
        const stop = onBrowserControlRequest((threadId) => {
            asked.push(threadId);

            return true;
        });

        show();

        expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
        expect(await screen.findByText(SITE_NAMED)).toBeTruthy();
        expect(screen.getByRole("img", { name: "What the agent's browser sees on shop.example.com" }).getAttribute("src")).toBe(
            "data:image/jpeg;base64,aGVsbG8=",
        );

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(asked).toEqual(["thread-1"]);
        expect(screen.getByRole("status").textContent).toBe("");
        stop();
    });

    it("says the browser cannot be taken over, never that it closed, when no live view card took the request", async () => {
        backend.browser = running();
        show();

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(screen.getByRole("status").textContent).toContain("The browser cannot be taken over right now.");
        expect(screen.getByRole("status").textContent).not.toContain("closed");
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it("offers Take control again once a new status arrives for that browser, as when the agent acts on it again", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running({ now: 1000 });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={PART} threadId="thread-1" />
            </QueryClientProvider>,
        );

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();

        backend.browser = running({ now: 2000 });
        await client.invalidateQueries({ queryKey: ["getThreadBrowser"] });

        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
    });

    it("in a comparison column, which has no live view card, points to the model's own chat instead of saying the browser closed", async () => {
        backend.browser = running();
        show(PART, false);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Open this model's chat on its own to take control");
        });
        expect(screen.getByRole("status").textContent).not.toContain("closed");
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it.each([
        // A late reader (the browser closed a minute after the ask): told plainly, and that a retry opens a new browser.
        [
            null,
            "The browser has closed, so this check can no longer be cleared here. Once the agent's reply has finished, ask it to try again: it opens a new browser",
        ],
        [running({ control: { byYou: true, until: Date.now() + 60_000 } }), "You have control."],
        [running({ control: { byYou: false, until: Date.now() + 60_000 } }), "Someone else has control of this browser."],
        [running({ canControl: false }), "Only someone who can write in this chat"],
        // An old card: a later reply's browser, or the asked browser moved on to another site, is not handed over from it.
        [running({ browserId: "b-2" }), "This check was for an earlier browser"],
        [running({ currentUrl: "https://other.example.org/" }), "The browser has since moved on from shop.example.com"],
    ])("offers no button when %j", async (browser, text) => {
        backend.browser = browser;
        show();

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain(text);
        });
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it.each(["https://shop.example.com./item", "https://shop.example.com../item"])(
        "offers Take control while the browser is at %s, its host spelled with trailing dots",
        async (currentUrl) => {
            backend.browser = running({ currentUrl });
            show();

            expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
            expect(screen.getByRole("status").textContent).not.toContain("moved on");
        },
    );

    it.each([
        [true, "You have control."],
        [false, "Someone else has control of this browser."],
    ])("offers Take control again once a lease (byYou %s) has lapsed on the server's clock", async (byYou, text) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            // The server's clock runs 5 s ahead of this device's: the lease ends 10 s after the answer on the server's.
            const serverNow = Date.now() + 5000;

            backend.browser = running({ control: { byYou, until: serverNow + 10_000 }, now: serverNow });
            show();

            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toContain(text);
            });
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
            expect(screen.getByRole("status").textContent).toBe("");
        } finally {
            vi.useRealTimers();
        }
    });

    it("offers no Take control once a lapsed lease leaves the browser on another site", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            backend.browser = running({ control: { byYou: true, until: Date.now() + 10_000 }, currentUrl: "https://other.example.org/" });
            show();

            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toContain("You have control.");
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("status").textContent).toContain("The browser has since moved on from shop.example.com");
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not call a browser closed when its status could not be read, and asks again on Try again", async () => {
        backend.browser = running();
        backend.fail = true;
        show();

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("could not be checked");
        });
        expect(screen.getByRole("status").textContent).not.toContain("closed");

        backend.fail = false;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("says so in text when no picture of the page came with the ask", async () => {
        backend.browser = running();
        show({
            ...PART,
            output: { humanCheck: { browserId: "b-1", site: "shop.example.com", status: "asked" }, success: false, url: "https://shop.example.com/item" },
        } as unknown as ToolPart);

        expect(await screen.findByText(NO_PICTURE)).toBeTruthy();
        expect(screen.queryByRole("img")).toBeNull();
        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
    });

    it("says only that no picture was taken on an answered ask, which offers no Take control", async () => {
        backend.browser = running();
        backend.check = openCheck({ canResolve: false, status: "done" });
        show({
            ...ASKED,
            output: { humanCheck: { browserId: "b-1", checkId: "check-1", run: "run-1", site: "shop.example.com", status: "asked" }, success: false },
        } as unknown as ToolPart);

        expect(await screen.findByText(MARKED_DONE)).toBeTruthy();
        expect(screen.getByText("No picture of the page could be taken.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it("moves focus to the status once the answer is saved, as the buttons go", async () => {
        backend.browser = running();
        backend.check = openCheck();
        show(ASKED);

        await userEvent.click(await screen.findByRole("button", { name: "Decline" }));

        await waitFor(() => {
            expect(screen.getByRole("status").matches(":focus")).toBe(true);
        });
    });

    it("moves focus to the heading when the answers go and the status has nothing to say", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );
        const decline = await screen.findByRole("button", { name: "Decline" });

        decline.focus();

        // Write access was taken away; the browser's status has not changed.
        backend.check = openCheck({ canResolve: false });
        await client.invalidateQueries({ queryKey: ["getHumanCheck"] });

        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        });
        expect(screen.getByRole("status").textContent).toBe("");
        expect(screen.getByRole("heading", { name: "Needs you" }).matches(":focus")).toBe(true);
    });

    it("offers only Decline for a browser that has closed, and no Take control hint", async () => {
        backend.browser = null;
        backend.check = openCheck();
        show(ASKED);

        expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
        expect(screen.queryByText(TAKE_CONTROL_HINT)).toBeNull();
    });

    it("leaves focus where the person moved it after a failed save, when the ask is answered elsewhere", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const elsewhere = document.createElement("input");

        document.body.appendChild(elsewhere);
        backend.browser = running();
        backend.check = openCheck();
        backend.answerFails = true;
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));
        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Your answer could not be saved.");
        });
        elsewhere.focus();

        backend.check = openCheck({ canResolve: false, status: "declined" });
        await client.invalidateQueries({ queryKey: ["getHumanCheck"] });

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("This check was declined.");
        });
        expect(elsewhere.matches(":focus")).toBe(true);
        elsewhere.remove();
    });

    it("drops the save error once the person may no longer answer", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running();
        backend.check = openCheck();
        backend.answerFails = true;
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        await userEvent.click(await screen.findByRole("button", { name: "Mark done" }));
        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Your answer could not be saved.");
        });

        backend.check = openCheck({ canResolve: false });
        await client.invalidateQueries({ queryKey: ["getHumanCheck"] });

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).not.toContain("Your answer could not be saved.");
        });
        expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    });

    it("says the browser closed each time a read past the subscription answers nothing, after a push in between", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.pushesOnly = true;
        backend.browser = running({ accessUntil: Date.now() + 600_000 });
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={PART} threadId="thread-1" />
            </QueryClientProvider>,
        );
        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();

        for (const round of [1, 2]) {
            backend.browser = null;
            await refocus();
            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toMatch(BROWSER_CLOSED);
            });

            if (round === 1) {
                // A new browser opens: its status pushes. The read past it after this answers later on the server's clock.
                backend.browser = running({ accessUntil: Date.now() + 600_000, now: Date.now() });
                await push(client, "getThreadBrowser", { threadId: "thread-1" }, backend.browser);
                expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
            }
        }
    });

    it("offers the answers once a read past a failed subscription says the ask is open", async () => {
        backend.liveCheckFails = true;
        backend.browser = running({ accessUntil: Date.now() + 600_000 });
        backend.check = openCheck({ accessUntil: Date.now() + 600_000 });
        show(ASKED);

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe("");
    });

    it("takes the later of two answers with the same server time", async () => {
        const readAt = Date.now();

        backend.pushesOnly = true;
        backend.browser = running({ accessUntil: readAt + 600_000, now: readAt });
        backend.check = openCheck({ accessUntil: readAt + 600_000, now: readAt });
        show(ASKED);
        expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();

        // Declined elsewhere in the same server millisecond; the subscription still holds the open ask.
        backend.check = openCheck({ accessUntil: readAt + 600_000, canResolve: false, now: readAt, status: "declined" });
        await refocus();

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toBe("This check was declined. The agent will not use this site again in this reply.");
        });
        expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    });

    it("says when the ask could not be read, and reads it again on Try again", async () => {
        backend.browser = running();
        backend.check = openCheck();
        backend.checkFails = true;
        show(ASKED);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Whether this check is still open could not be checked.");
        });

        backend.checkFails = false;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
    });

    it("times the ask out on the server's clock, not the device's", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            // The device runs 20 s behind the server: by the device's clock the ask still has 10 s to go at the server's 30 s.
            const serverNow = Date.now() + 20_000;

            backend.browser = null;
            backend.check = openCheck({ expiresAt: serverNow + 10_000, now: serverNow });
            show(ASKED);

            expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("status").textContent).toContain("This check is no longer open.");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the Needs you card after the browser moved on", () => {
    it("still offers Mark done while the ask is open, and says what the person can do", async () => {
        // The check was a sign-in that led to another host once cleared, and the person handed the browser back.
        backend.browser = running({ currentUrl: "https://accounts.example.org/done" });
        backend.check = openCheck();
        show(ASKED);

        expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe(
            "The browser has since moved on from shop.example.com. Mark the check done if you cleared it, or decline it.",
        );
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });
});

describe("the Needs you card's focus", () => {
    it("keeps focus on the answer pressed while it saves, says it is saving, and sends it once", async () => {
        let release = (): void => {};

        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        backend.answerHeld = new Promise<void>((resolve: () => void) => {
            release = resolve;
        });
        backend.browser = running();
        backend.check = openCheck();
        show(ASKED);

        const decline = await screen.findByRole("button", { name: "Decline" });

        await userEvent.click(decline);
        // A natively disabled button loses focus in a browser; one that stays focusable keeps it.
        await waitFor(() => {
            expect(decline.getAttribute("aria-disabled")).toBe("true");
        });
        expect(decline.matches(":focus")).toBe(true);
        // The status region, mounted throughout, says why the button waits.
        expect(screen.getByRole("status").textContent).toBe("Saving your answer…");
        await userEvent.keyboard("{Enter}");
        expect(backend.answers).toHaveLength(1);

        await act(async () => {
            release();
        });
        await waitFor(() => {
            expect(screen.getByRole("status").matches(":focus")).toBe(true);
        });
    });

    it("moves no focus when the answers go after the person left them for the page", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        backend.browser = running();
        backend.check = openCheck();
        render(
            <QueryClientProvider client={client}>
                <HumanCheckCard liveViewHere part={ASKED} threadId="thread-1" />
            </QueryClientProvider>,
        );

        const decline = await screen.findByRole("button", { name: "Decline" });

        decline.focus();
        // A click on the page's text: focus goes to the page, the button stays.
        decline.blur();
        await act(async () => {
            await Promise.resolve();
        });

        // Answered in another tab, a while later.
        backend.check = openCheck({ canResolve: false, status: "done" });
        await client.invalidateQueries();

        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
        });
        expect(screen.getByRole("status").matches(":focus")).toBe(false);
        expect(screen.getByRole("heading", { name: "Needs you" }).matches(":focus")).toBe(false);
    });
});
