// @vitest-environment jsdom

/**
 * The owner's guest-link panel shows a made address only while the live read holds that very link, and stops showing a link
 * as live when it ends, without waiting for the next read. Its revoke deletes only the waiting notes the owner confirmed, by
 * id, asks again about the notes waiting now when one waits they did not see, and is declined when they move to another chat.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE_UNTIL = /^Link active until/u;
const revoke = vi.fn(async (_args: { confirmedNotes: string[]; linkId: string }) => null);
const readLink = vi.fn(async () => {
    return { link: null, messages: [] as { id: string; status: string }[] };
});

// The query client tells its observers on a microtask, not a timer, so an update lands inside `act`.
notifyManager.setScheduler(queueMicrotask);

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
        revokeGuestLink: {
            mutationOptions: () => {
                return { mutationFn: revoke };
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
const { default: useGuestLinkRevoke } = await import("./use-guest-link-revoke");

const showPanel = (read: unknown) => {
    const client = new QueryClient();

    client.setQueryData(["guest-link"], read);
    render(
        <QueryClientProvider client={client}>
            <GuestLinkPanel revokeLink={async () => true} threadId="thread-1" />
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
    const outcome: { settled: boolean; value?: boolean } = { settled: false };

    act(() => {
        void run().then((value) => {
            outcome.settled = true;
            outcome.value = value;

            return value;
        });
    });

    return outcome;
};

afterEach(() => {
    vi.useRealTimers();
    revoke.mockReset();
    readLink.mockClear();
});

describe("GuestLinkPanel", () => {
    it("shows a made address only while the live read holds that link, not once it is replaced or revoked elsewhere", async () => {
        const readNow = showPanel({ link: null, messages: [] });

        fireEvent.click(screen.getByRole("button", { name: "Create guest link" }));
        await readNow({ link: { bound: false, expiresAt: Date.now() + DAY, id: "link-1" }, messages: [] });
        expect(screen.getByRole("textbox", { name: "Guest link" })).toBeTruthy();

        // Another tab made a new link (same end time is possible): the address made here is not the live one any more.
        await readNow({ link: { bound: false, expiresAt: Date.now() + DAY, id: "link-2" }, messages: [] });
        expect(screen.queryByRole("textbox", { name: "Guest link" })).toBeNull();

        await readNow({ link: null, messages: [] });
        expect(screen.queryByRole("textbox", { name: "Guest link" })).toBeNull();
    });

    it("offers Create once the link ends, without a new read", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        showPanel({ link: { bound: false, expiresAt: Date.now() + 1000, id: "link-1" }, messages: [] });

        expect(screen.getByText(ACTIVE_UNTIL)).toBeTruthy();

        act(() => vi.advanceTimersByTime(1000));

        expect(screen.queryByText(ACTIVE_UNTIL)).toBeNull();
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
        readLink.mockResolvedValueOnce({ link: null, messages: [{ id: "note-b", status: "held" }] });

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
});
