// @vitest-environment jsdom

/**
 * The owner's guest-link panel shows a made address only while the live read holds that very link, and stops showing a link
 * as live when it ends, without waiting for the next read. Its revoke deletes only the waiting notes the owner confirmed, by
 * id, asks again about the notes waiting now when one waits they did not see, and is declined when they move to another chat.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SendOutcome } from "@/features/chat/core/context/send-message";

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE_UNTIL = /^Link active until/u;
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
/** What the chat's streaming context says: `isStreaming` counts a local reply in any chat, `isThreadStreaming` only this one's. */
const streaming = vi.hoisted(() => {
    return { isStreaming: false, isThreadStreaming: false };
});
const reviewSend = vi.fn(async () => {
    return { status: "ready" as const, text: "please call me back", threadId: "thread-1" };
});
const dismissNote = vi.fn(async () => {
    return { status: "dismissed" as const };
});
const revoke = vi.fn(async (_args: { confirmedNotes: string[]; linkId: string }) => null);
const readLink = vi.fn(async () => {
    return { link: null as { bound?: boolean; expiresAt?: number; id: string } | null, messages: [] as { id: string; status: string }[] };
});

// The query client tells its observers on a microtask, not a timer, so an update lands inside `act`.
notifyManager.setScheduler(queueMicrotask);

vi.mock("sonner", () => {
    return { toast: { error: toastError, info: toastInfo, success: vi.fn() } };
});
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@lingui/core/macro", () => {
    return { plural: (_count: number, forms: { other: string }) => forms.other };
});
vi.mock("@neore/client-runtime", () => {
    return { useUnlockProof: () => undefined };
});
vi.mock("@/features/chat/core/context/chat-context-hooks", () => {
    return { useChatIsStreaming: () => streaming };
});
vi.mock("@/components/delete-confirmation-dialog", () => {
    return { default: () => null };
});
vi.mock("@/lib/lunora/crpc", () => {
    const guestLinks = {
        createGuestLink: {
            mutationOptions: () => {
                return {
                    mutationFn: async () => {
                        return { expiresAt: Date.now() + DAY, id: "link-1", linkToken: "ab".repeat(32) };
                    },
                };
            },
        },
        // The panel's tests set what the read holds; the revoke's fresh read asks `readLink`.
        getGuestLink: {
            queryOptions: () => {
                return { queryFn: readLink, queryKey: ["guest-link"], staleTime: Infinity };
            },
        },
        dismissHeldGuestMessage: {
            mutationOptions: () => {
                return { mutationFn: dismissNote };
            },
        },
        revokeGuestLink: {
            mutationOptions: () => {
                return { mutationFn: revoke };
            },
        },
        sendHeldGuestMessage: {
            mutationOptions: () => {
                return { mutationFn: reviewSend };
            },
        },
    };

    return {
        useCRPC: () => {
            return { chat: { guest_links: guestLinks } };
        },
    };
});

const { default: GuestLinkPanel } = await import("./guest-link-panel");
const { clearSendStarting, markSendStarting } = await import("@/features/chat/core/utils/send-in-flight");
const { default: useGuestLinkRevoke } = await import("./use-guest-link-revoke");
const { default: useGuestNoteSend } = await import("./use-guest-note-send");

const showPanel = (read: unknown, props: Partial<ComponentProps<typeof GuestLinkPanel>> = {}) => {
    const client = new QueryClient();

    client.setQueryData(["guest-link"], read);
    render(
        <QueryClientProvider client={client}>
            <GuestLinkPanel
                revokeLink={async () => true}
                sendNote={async () => {
                    return { kind: "sent" as const };
                }}
                threadId="thread-1"
                {...props}
            />
        </QueryClientProvider>,
    );

    // The read answers anew: observers hear of it on the next microtask, which `act` waits for.
    return async (next: unknown) => {
        await act(async () => {
            client.setQueryData(["guest-link"], next);
        });
    };
};

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

/** Starts a revoke and tracks whether it has settled, without waiting on real time. */
const start = (run: () => Promise<boolean>) => {
    const outcome: { error?: unknown; settled: boolean; value?: boolean } = { settled: false };

    act(() => {
        void run()
            .then((value) => {
                outcome.settled = true;
                outcome.value = value;

                return value;
            })
            .catch((error: unknown) => {
                outcome.settled = true;
                outcome.error = error;
            });
    });

    return outcome;
};

afterEach(() => {
    vi.useRealTimers();
    revoke.mockReset();
    readLink.mockReset();
    dismissNote.mockClear();
    toastError.mockClear();
    toastInfo.mockClear();
});

/** A live link with one note waiting, as the read answers it. */
const NOTE = { createdAt: 0, id: "note-1", status: "held", text: "please call me back" };
const WAITING = { link: { bound: true, expiresAt: Date.now() + DAY, id: "link-1" }, messages: [NOTE] };
const SEND = /^Send: please call me back/u;
const SEND_SECOND = /^Send: and the invoice/u;
const INTRO = /^Anyone with a guest link can leave you a message here/u;
const DISMISS = /^Dismiss note: please call me back/u;

type SendToChat = (text: string, guestMessageId: string) => Promise<SendOutcome>;

/** The ordinary send took the note: the gateway started its reply. */
const started: SendToChat = async () => {
    return { refused: false, started: true };
};

/** The share button's part: it holds the note's Send, and opens the panel only while the menu is open. */
const Host = ({ onSendNote, open }: { onSendNote: SendToChat; open: boolean }) => {
    const { sendingId, sendNote, turnRunning } = useGuestNoteSend("thread-1", onSendNote);

    return open ? (
        <GuestLinkPanel revokeLink={async () => true} sendingId={sendingId} sendNote={sendNote} threadId="thread-1" turnRunning={turnRunning} />
    ) : null;
};

/** Opens the menu on a read; the returned call opens or closes it. */
const showHost = (read: unknown, onSendNote: SendToChat) => {
    const client = new QueryClient();
    const ui = (open: boolean) => (
        <QueryClientProvider client={client}>
            <Host onSendNote={onSendNote} open={open} />
        </QueryClientProvider>
    );

    client.setQueryData(["guest-link"], read);

    const { rerender } = render(ui(true));

    // Opens or closes the menu; `turnRunning`: a reply starts (or ends) in this thread.
    const setView = (open: boolean, turnRunning = false) => {
        streaming.isThreadStreaming = turnRunning;
        rerender(ui(open));
    };

    // The live read pushes an update, as a subscription does.
    const update = async (next: unknown) => {
        await act(async () => {
            client.setQueryData(["guest-link"], next);
        });
    };

    return Object.assign(setView, { update });
};

describe("GuestLinkPanel's Send and Dismiss", () => {
    afterEach(() => {
        clearSendStarting("thread-1");
        reviewSend.mockClear();
        streaming.isStreaming = false;
        streaming.isThreadStreaming = false;
    });

    it("sends a waiting note's own text with its id through the ordinary send", async () => {
        const onSendNote = vi.fn(started);

        readLink.mockResolvedValue(WAITING);
        showHost(WAITING, onSendNote);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(onSendNote).toHaveBeenCalledWith("please call me back", "note-1"));
    });

    it.each([
        ["moves to another chat", (view: { rerender: (props: { threadId: string }) => void; unmount: () => void }) => view.rerender({ threadId: "thread-2" })],
        ["leaves the chat view", (view: { rerender: (props: { threadId: string }) => void; unmount: () => void }) => view.unmount()],
    ] as const)("holds a note whose review answers after the owner %s: its own thread's state is not known there", async (_name, leave) => {
        const onSendNote = vi.fn(started);
        let answer: (value: { status: "ready"; text: string; threadId: string }) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const review = new Promise<{ status: "ready"; text: string; threadId: string }>((resolve) => {
            answer = resolve;
        });

        reviewSend.mockImplementationOnce(async () => await review);

        const view = renderHook(({ threadId }: { threadId: string }) => useGuestNoteSend(threadId, onSendNote), {
            initialProps: { threadId: "thread-1" },
            wrapper,
        });
        let outcome: unknown;

        act(() => {
            void view.result.current.sendNote("note-1").then((value) => {
                outcome = value;

                return value;
            });
        });
        leave(view);

        await act(async () => {
            answer({ status: "ready", text: "please call me back", threadId: "thread-1" });
        });

        expect(outcome).toStrictEqual({ kind: "busy" });
        expect(onSendNote).not.toHaveBeenCalled();
    });

    it("does not count a refused send as delivered: it says why, and the note stays waiting", async () => {
        readLink.mockResolvedValue(WAITING);
        showHost(WAITING, async () => {
            return { failure: "That guest link has ended.", refused: false, started: false };
        });
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith("That guest link has ended."));
        expect(screen.getByRole("status").textContent).toBe("");
        expect(screen.getByRole("button", { name: SEND })).toBeTruthy();
    });

    it("holds a note while another send in the thread has begun and its reply does not stream yet", async () => {
        const onSendNote = vi.fn(started);

        markSendStarting("thread-1");
        showHost(WAITING, onSendNote);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("A reply is running. Send a message once it has finished."));
        expect(onSendNote).not.toHaveBeenCalled();
    });

    it("still sends a note when the menu closes mid-check, and keeps its Dismiss off when the menu opens again", async () => {
        const onSendNote = vi.fn(started);
        let answer: (value: { status: "ready"; text: string; threadId: string }) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const review = new Promise<{ status: "ready"; text: string; threadId: string }>((resolve) => {
            answer = resolve;
        });

        readLink.mockResolvedValue(WAITING);
        reviewSend.mockImplementationOnce(async () => await review);

        const setOpen = showHost(WAITING, onSendNote);

        fireEvent.click(screen.getByRole("button", { name: SEND }));
        setOpen(false);
        setOpen(true);

        await waitFor(() => expect((screen.getByRole("button", { name: DISMISS }) as HTMLButtonElement).disabled).toBe(true));

        await act(async () => {
            answer({ status: "ready", text: "please call me back", threadId: "thread-1" });
        });

        await waitFor(() => expect(onSendNote).toHaveBeenCalledWith("please call me back", "note-1"));
    });

    it("says Sent once the note reads as sent, and moves focus to the next note's Send", async () => {
        const second = { createdAt: 1, id: "note-2", status: "held", text: "and the invoice" };

        readLink.mockResolvedValue({ ...WAITING, messages: [{ ...NOTE, status: "sent" }, second] });
        showHost({ ...WAITING, messages: [...WAITING.messages, second] }, started);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sent"));
        expect(screen.getByRole("button", { name: SEND_SECOND }).matches(":focus")).toBe(true);
    });

    it("announces every send, a second one in the open panel included", async () => {
        const second = { createdAt: 1, id: "note-2", status: "held", text: "and the invoice" };

        readLink.mockResolvedValueOnce({ ...WAITING, messages: [{ ...NOTE, status: "sent" }, second] }).mockResolvedValueOnce({
            ...WAITING,
            messages: [
                { ...NOTE, status: "sent" },
                { ...second, status: "sent" },
            ],
        });
        showHost({ ...WAITING, messages: [NOTE, second] }, started);
        fireEvent.click(screen.getByRole("button", { name: SEND }));
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sent"));

        fireEvent.click(screen.getByRole("button", { name: SEND_SECOND }));

        // Emptied while the second goes, so its "Sent" is a change the region announces.
        expect(screen.getByRole("status").textContent).toBe("");
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sent"));
    });

    it("moves focus forward to the note after the one sent, not back to an earlier one still waiting", async () => {
        const first = { createdAt: 0, id: "note-0", status: "held", text: "an earlier note" };
        const last = { createdAt: 2, id: "note-2", status: "held", text: "and the invoice" };

        readLink.mockResolvedValue({ ...WAITING, messages: [first, { ...NOTE, status: "sent" }, last] });
        showHost({ ...WAITING, messages: [first, NOTE, last] }, started);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(screen.getByRole("button", { name: SEND_SECOND }).matches(":focus")).toBe(true));
    });

    it("moves focus to the list when the next note's Send is off because the sent note's reply is running", async () => {
        const second = { createdAt: 1, id: "note-2", status: "held", text: "and the invoice" };
        let answer: (value: unknown) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const read = new Promise((resolve) => {
            answer = resolve;
        });

        readLink.mockImplementationOnce(async () => (await read) as never);

        const setView = showHost({ ...WAITING, messages: [NOTE, second] }, started);

        fireEvent.click(screen.getByRole("button", { name: SEND }));
        await waitFor(() => expect(readLink).toHaveBeenCalled());
        // The note's reply starts before the fresh read answers.
        setView(true, true);

        await act(async () => {
            answer({ ...WAITING, messages: [{ ...NOTE, status: "sent" }, second] });
        });

        await waitFor(() => expect(screen.getByRole("list", { name: "Guest messages" }).matches(":focus")).toBe(true));
    });

    it("says Sent and moves focus once the live read shows the note sent, though the fresh read answered with what it held", async () => {
        const second = { createdAt: 1, id: "note-2", status: "held", text: "and the invoice" };
        const before = { ...WAITING, messages: [NOTE, second] };

        // The subscription answers the refetch with its current value; the update comes after.
        readLink.mockResolvedValue(before);

        const view = showHost(before, started);

        fireEvent.click(screen.getByRole("button", { name: SEND }));
        await waitFor(() => expect(readLink).toHaveBeenCalled());

        expect(screen.getByRole("status").textContent).toBe("");

        await view.update({ ...WAITING, messages: [{ ...NOTE, status: "sent" }, second] });

        expect(screen.getByRole("status").textContent).toBe("Sent");
        expect(screen.getByRole("button", { name: SEND_SECOND }).matches(":focus")).toBe(true);
    });

    it("keeps Send on while a local reply streams in another chat: only a reply in this thread holds it", async () => {
        const onSendNote = vi.fn(started);

        streaming.isStreaming = true;
        readLink.mockResolvedValue(WAITING);
        showHost(WAITING, onSendNote);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(onSendNote).toHaveBeenCalledWith("please call me back", "note-1"));
    });

    it("reads the link afresh after a Send finds the note already sent, so it no longer shows as waiting", async () => {
        reviewSend.mockResolvedValueOnce({ status: "sent" } as never);
        readLink.mockResolvedValue({ ...WAITING, messages: [{ ...NOTE, status: "sent" }] });
        showHost(WAITING, started);
        fireEvent.click(screen.getByRole("button", { name: SEND }));

        await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("That message was already sent."));
        await waitFor(() => expect(screen.queryByRole("button", { name: SEND })).toBeNull());
    });

    it("moves focus to the next waiting note's Send once a dismissed note is gone, so it is not left behind", async () => {
        const second = { createdAt: 1, id: "note-2", status: "held", text: "and the invoice" };

        readLink.mockResolvedValue({ ...WAITING, messages: [second] });
        showPanel({ ...WAITING, messages: [NOTE, second] });
        fireEvent.click(screen.getByRole("button", { name: DISMISS }));

        await waitFor(() => expect(screen.getByRole("button", { name: SEND_SECOND }).matches(":focus")).toBe(true));
        expect(screen.getByRole("status").textContent).toBe("");
    });

    it("moves focus to the panel's intro once the last note is dismissed and the list itself is gone", async () => {
        readLink.mockResolvedValue({ ...WAITING, messages: [] });
        showPanel(WAITING);
        fireEvent.click(screen.getByRole("button", { name: DISMISS }));

        await waitFor(() => expect(screen.queryByRole("list", { name: "Guest messages" })).toBeNull());
        expect(screen.getByText(INTRO).matches(":focus")).toBe(true);
    });

    it("reads the link afresh after a Dismiss, so the dismissed note no longer shows", async () => {
        readLink.mockResolvedValue({ ...WAITING, messages: [] });
        showPanel(WAITING);
        fireEvent.click(screen.getByRole("button", { name: DISMISS }));

        await waitFor(() => expect(screen.queryByRole("button", { name: DISMISS })).toBeNull());
    });

    it.each([
        ["GUEST_NOTE_GONE", toastError, "That message is no longer waiting."],
        ["GUEST_LINK_ENDED", toastError, "The guest link was replaced or has ended."],
        ["GUEST_NOTE_BEING_SENT", toastInfo, "That message is being sent."],
    ] as const)("says why a Dismiss was refused (%s), in the app's words", async (code, toast, message) => {
        dismissNote.mockRejectedValueOnce({ code: "BAD_REQUEST", data: { code } });
        showPanel(WAITING);
        fireEvent.click(screen.getByRole("button", { name: DISMISS }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(message));
    });
});

describe("GuestLinkPanel", () => {
    it("shows a made address only while the live read holds that link, not once it is replaced or revoked elsewhere", async () => {
        const readNow = showPanel({ link: null, messages: [] });

        // The panel reads the link again after making it (a live read can fall back to one-shot): that read holds it.
        readLink.mockResolvedValueOnce({ link: { bound: false, expiresAt: Date.now() + DAY, id: "link-1" }, messages: [] });
        fireEvent.click(screen.getByRole("button", { name: "Create guest link" }));
        expect(await screen.findByRole("textbox", { name: "Guest link" })).toBeTruthy();

        // Another tab made a new link (same end time is possible): the address made here is not the live one any more.
        await readNow({ link: { bound: false, expiresAt: Date.now() + DAY, id: "link-2" }, messages: [] });
        expect(screen.queryByRole("textbox", { name: "Guest link" })).toBeNull();

        await readNow({ link: null, messages: [] });
        expect(screen.queryByRole("textbox", { name: "Guest link" })).toBeNull();
    });

    it("offers Create once the link ends, without a new read, and hides its notes", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        showPanel({ link: { bound: false, expiresAt: Date.now() + 1000, id: "link-1" }, messages: [{ createdAt: 0, id: "n", status: "held", text: "hi" }] });

        expect(screen.getByText(ACTIVE_UNTIL)).toBeTruthy();

        act(() => vi.advanceTimersByTime(1000));

        expect(screen.queryByText(ACTIVE_UNTIL)).toBeNull();
        expect(screen.getByRole("button", { name: "Create guest link" })).toBeTruthy();
        expect(screen.queryByRole("list", { name: "Guest messages" })).toBeNull();
    });

    it("tells the owner to copy the address by hand where the browser has no Clipboard API", async () => {
        showPanel({ link: null, messages: [] });
        readLink.mockResolvedValueOnce({ link: { bound: false, expiresAt: Date.now() + DAY, id: "link-1" }, messages: [] });
        fireEvent.click(screen.getByRole("button", { name: "Create guest link" }));
        await screen.findByRole("textbox", { name: "Guest link" });

        fireEvent.click(screen.getByRole("button", { name: "Copy" }));

        expect(toastError).toHaveBeenCalledWith("The link could not be copied. Select it and copy it yourself.");
    });

    it("does not show a link as live that ended before the read answered", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const mountedAt = Date.now();
        const readNow = showPanel({ link: null, messages: [] });

        // The read answers two seconds after the panel mounted, with a link that ended one second after it.
        vi.setSystemTime(mountedAt + 2000);
        await readNow({ link: { bound: false, expiresAt: mountedAt + 1000, id: "link-1" }, messages: [] });

        expect(screen.queryByText(ACTIVE_UNTIL)).toBeNull();
        expect(screen.getByRole("button", { name: "Create guest link" })).toBeTruthy();
    });

    it("never asks a timeout to wait longer than a browser can, even for a link ending weeks after the client's clock", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const timeout = vi.spyOn(globalThis, "setTimeout");

        showPanel({ link: { bound: false, expiresAt: Date.now() + 30 * DAY, id: "link-1" }, messages: [] });

        expect(Math.max(...timeout.mock.calls.map(([, delay]) => delay ?? 0))).toBeLessThanOrEqual(2_147_483_647);
        expect(screen.getByText(ACTIVE_UNTIL)).toBeTruthy();
    });

    it("moves focus to Create when the link ends while Revoke has it", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        showPanel({ link: { bound: false, expiresAt: Date.now() + 1000, id: "link-1" }, messages: [] });

        act(() => screen.getByRole("button", { name: "Revoke link" }).focus());
        act(() => vi.advanceTimersByTime(1000));

        expect(screen.getByRole("button", { name: "Create guest link" }).matches(":focus")).toBe(true);
    });

    it("waits again even when its timer fires at the very time the panel last read", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        showPanel({ link: { bound: false, expiresAt: Date.now() + 1000, id: "link-1" }, messages: [] });

        // The clock moves back by exactly the wait: when the timer fires, it reads the time the panel mounted.
        vi.setSystemTime(Date.now() - 1000);
        act(() => vi.advanceTimersByTime(1000));
        act(() => vi.advanceTimersByTime(1000));

        expect(screen.getByRole("button", { name: "Create guest link" })).toBeTruthy();
    });

    it("waits again when its timer fires before the link has ended, as when the clock moved back", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        showPanel({ link: { bound: false, expiresAt: Date.now() + 1000, id: "link-1" }, messages: [] });

        // The clock moves back two seconds: the timer still fires after one, with the link a further two from its end.
        vi.setSystemTime(Date.now() - 2000);
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.getByText(ACTIVE_UNTIL)).toBeTruthy();

        act(() => vi.advanceTimersByTime(2000));
        expect(screen.getByRole("button", { name: "Create guest link" })).toBeTruthy();
    });
});

describe(useGuestLinkRevoke, () => {
    it("declines a confirm left open when the owner moves to another chat, and revokes nothing", async () => {
        const { rerender, result } = renderHook(({ threadId }) => useGuestLinkRevoke(threadId), { initialProps: { threadId: "thread-1" }, wrapper });
        const outcome = start(() => result.current.revokeLink("link-1", ["note-a"]));

        rerender({ threadId: "thread-2" });
        // The decline settles the revoke on the microtasks that follow, not on a timer.
        await act(async () => {
            await Promise.resolve();
        });

        expect(outcome).toStrictEqual({ settled: true, value: false });
        expect(revoke).not.toHaveBeenCalled();
    });

    it("asks again about the notes waiting now when one waits the owner did not see, and revokes only those", async () => {
        const { result } = renderHook(() => useGuestLinkRevoke("thread-1"), { wrapper });
        const confirm = async () => {
            await act(async () => (result.current.confirmDialog as { props: { onConfirm: () => void } }).props.onConfirm());
        };

        // Note A was sent from another device and a guest left B: the server refuses the ids the owner confirmed.
        revoke.mockRejectedValueOnce({ code: "BAD_REQUEST", data: { code: "GUEST_NOTES_WAITING", waiting: 1 } });
        readLink.mockResolvedValueOnce({ link: { id: "link-1" }, messages: [{ id: "note-b", status: "held" }] });

        const outcome = start(() => result.current.revokeLink("link-1", ["note-a"]));

        await confirm();
        await confirm();

        // Both times for the link the owner saw, never one read since.
        expect(revoke.mock.calls.map(([args]) => [args.linkId, args.confirmedNotes])).toStrictEqual([
            ["link-1", ["note-a"]],
            ["link-1", ["note-b"]],
        ]);
        expect(outcome).toStrictEqual({ settled: true, value: true });
    });

    it("stops, without asking or retrying, when the server refuses again but no unconfirmed note is shown", async () => {
        const { result } = renderHook(() => useGuestLinkRevoke("thread-1"), { wrapper });

        // The server counts a note on another live link, which the read does not list: there is nothing new to ask about.
        revoke.mockRejectedValueOnce({ code: "BAD_REQUEST", data: { code: "GUEST_NOTES_WAITING", waiting: 2 } });
        readLink.mockResolvedValueOnce({ link: { id: "link-1" }, messages: [{ id: "note-a", status: "held" }] });

        const outcome = start(() => result.current.revokeLink("link-1", ["note-a"]));

        await act(async () => (result.current.confirmDialog as { props: { onConfirm: () => void } }).props.onConfirm());

        expect(revoke).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ error: { message: "The revoke was refused, and no unconfirmed note is shown." }, settled: true });
    });

    it("asks nothing about a link replaced since the owner confirmed, and reports it ended", async () => {
        const { result } = renderHook(() => useGuestLinkRevoke("thread-1"), { wrapper });

        // Refused, and the fresh read finds another tab's new link, with its own note.
        revoke.mockRejectedValueOnce({ code: "BAD_REQUEST", data: { code: "GUEST_NOTES_WAITING", waiting: 1 } });
        readLink.mockResolvedValueOnce({ link: { id: "link-2" }, messages: [{ id: "note-new", status: "held" }] });

        const outcome = start(() => result.current.revokeLink("link-1", ["note-a"]));

        await act(async () => (result.current.confirmDialog as { props: { onConfirm: () => void } }).props.onConfirm());

        expect((result.current.confirmDialog as { props: { open: boolean } }).props.open).toBe(false);
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(outcome).toMatchObject({ error: { data: { code: "GUEST_LINK_ENDED" } }, settled: true });
    });
});
