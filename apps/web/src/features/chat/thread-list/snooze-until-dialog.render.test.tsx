// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SnoozeOutcome } from "./hooks/use-thread-state-actions";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";

const state = vi.hoisted(() => {
    return { snoozeAt: vi.fn<(threadId: string, until: number, previousUntil: number | undefined) => Promise<SnoozeOutcome>>() };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("./hooks/use-thread-state-actions", () => {
    return {
        useThreadStateActions: () => {
            return { snoozeAt: state.snoozeAt };
        },
    };
});

// The real dialog needs browser APIs jsdom lacks; the form it holds is what is under test.
vi.mock("@neore/ui/components/responsive-dialog", () => {
    const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

    return { Dialog: Box, DialogContent: Box, DialogDescription: Box, DialogFooter: Box, DialogHeader: Box, DialogTitle: Box };
});

const { default: SnoozeUntilDialog, closeSnoozeDialogFor, threadRowFocusTarget } = await import("./snooze-until-dialog");

const mountDialog = (): ReturnType<typeof vi.fn> => {
    const onOpenChange = vi.fn();

    render(<SnoozeUntilDialog onOpenChange={onOpenChange} open previousUntil={undefined} returnFocusTo={() => null} threadId="t1" />);

    return onOpenChange;
};

const submit = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
};

const wakeInput = (): HTMLInputElement => screen.getByLabelText("Wake up at") as HTMLInputElement;

/** The local `YYYY-MM-DDTHH:mm` a `datetime-local` input takes. */
const localInput = (time: Date): string => {
    const pad = (value: number): string => String(value).padStart(2, "0");

    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}`;
};

describe("SnoozeUntilDialog when the send fails", () => {
    beforeEach(() => {
        state.snoozeAt.mockReset();
    });

    it("shows the error in the dialog, keeps the chosen time, re-enables Snooze, returns focus to it, and Cancel closes it", async () => {
        // An offline custom snooze is refused at once: the action reports a failed save, with the error toast already shown.
        state.snoozeAt.mockResolvedValueOnce("refused");
        const onOpenChange = mountDialog();
        const chosen = localInput(new Date(Date.now() + 2 * 60 * 60 * 1000));

        fireEvent.change(wakeInput(), { target: { value: chosen } });
        submit();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Could not snooze the thread. Please try again.");
        expect(wakeInput().value).toBe(chosen);

        const snooze = screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement;

        expect(snooze.disabled).toBe(false);
        // The Snooze button itself holds focus: the same element, and it is a button.
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(snooze);
        expect(document.activeElement?.tagName).toBe("BUTTON");
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("a submit with no time shows its own error, keeps the dialog open, saves nothing, and focuses the time field", async () => {
        const onOpenChange = mountDialog();

        fireEvent.change(wakeInput(), { target: { value: "" } });
        submit();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Choose a wake-up time.");
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(state.snoozeAt).not.toHaveBeenCalled();
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(wakeInput());
    });

    it("lets Cancel close the dialog while a send that never settles is still pending", async () => {
        state.snoozeAt.mockReturnValueOnce(new Promise<SnoozeOutcome>(() => {}));
        const onOpenChange = mountDialog();

        submit();

        expect(await screen.findByText("Saving…")).toBeTruthy();

        const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

        expect(cancel.disabled).toBe(false);
        // The time cannot change under a save in flight.
        expect(wakeInput().disabled).toBe(true);

        fireEvent.click(cancel);

        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

/** The list's wiring: one dialog per open thread, closed through the same helper the list uses. */
const ListDialogs = () => {
    const threadId = useThreadListUIStore((ui) => ui.snoozeThreadId);

    if (threadId === null) {
        return null;
    }

    return (
        <SnoozeUntilDialog
            key={threadId}
            onOpenChange={(open) => {
                if (!open) {
                    closeSnoozeDialogFor(threadId);
                }
            }}
            open
            previousUntil={undefined}
            returnFocusTo={() => threadRowFocusTarget(document.body, threadId)}
            threadId={threadId}
        />
    );
};

/** The list's rows, which the dialog returns focus to. */
const ListRows = () => (
    <>
        <div data-thread-id="thread-a" role="button" tabIndex={0}>
            Thread A
        </div>
        <div data-thread-id="thread-b" role="button" tabIndex={0}>
            Thread B
        </div>
    </>
);

describe("the list's snooze dialog across threads", () => {
    beforeEach(() => {
        state.snoozeAt.mockReset();
        useThreadListUIStore.getState().setSnoozeThreadId(null);
    });

    it("a save cancelled and then reopened for the same thread does not close the new opening", async () => {
        let released = false;
        let saveSettled = false;

        state.snoozeAt.mockImplementationOnce(async () => {
            await vi.waitFor(() => {
                if (!released) {
                    throw new Error("The save is still in flight");
                }
            });
            saveSettled = true;

            return "saved";
        });
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(
            <>
                <ListRows />
                <ListDialogs />
            </>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
        expect(await screen.findByText("Saving…")).toBeTruthy();

        // The owner cancels, and reopens the same thread's dialog while the save is still in flight.
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(useThreadListUIStore.getState().snoozeThreadId).toBeNull();
        act(() => {
            useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        });

        released = true;
        await vi.waitFor(() => {
            expect(saveSettled).toBe(true);
        });

        expect(useThreadListUIStore.getState().snoozeThreadId).toBe("thread-a");
        expect(screen.getByLabelText("Wake up at")).toBeTruthy();
    });

    it("a save for thread A that finishes after thread B's dialog opened leaves B's dialog open", async () => {
        // A's save stays in flight until the test releases it, after B's dialog has opened. The save waits on a condition the test
        // sets, not on a delay, so a slow run cannot let it settle early.
        let released = false;
        let saveSettled = false;

        state.snoozeAt.mockImplementationOnce(async () => {
            await vi.waitFor(() => {
                if (!released) {
                    throw new Error("A's save is still in flight");
                }
            });
            saveSettled = true;

            return "saved";
        });
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(
            <>
                <ListRows />
                <ListDialogs />
            </>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
        expect(await screen.findByText("Saving…")).toBeTruthy();

        // The owner opens another thread's snooze while A's save is still in flight.
        act(() => {
            useThreadListUIStore.getState().setSnoozeThreadId("thread-b");
        });

        released = true;
        // The save has settled, and the dialog's close after it has run, once this poll sees it: it polls after the microtasks.
        await vi.waitFor(() => {
            expect(saveSettled).toBe(true);
        });

        expect(useThreadListUIStore.getState().snoozeThreadId).toBe("thread-b");
        expect(screen.getByLabelText("Wake up at")).toBeTruthy();
    });

    it("a save that finishes for the thread still open closes its dialog", async () => {
        state.snoozeAt.mockResolvedValueOnce("saved");
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(
            <>
                <ListRows />
                <ListDialogs />
            </>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

        await waitFor(() => {
            expect(useThreadListUIStore.getState().snoozeThreadId).toBeNull();
        });
    });

    it("returns focus to the thread's row once a save closes the dialog", async () => {
        state.snoozeAt.mockResolvedValueOnce("saved");
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(
            <>
                <ListRows />
                <ListDialogs />
            </>,
        );

        // Focus starts on the Snooze button, as it does for a user who clicked or tabbed to it.
        const snooze = screen.getByRole("button", { name: "Snooze" });

        snooze.focus();
        fireEvent.click(snooze);

        await waitFor(() => {
            expect(useThreadListUIStore.getState().snoozeThreadId).toBeNull();
        });
        // The focus return is a timer after the dialog unmounts: wait for the condition, not a delay.
        await waitFor(() => {
            // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
            expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thread A" }));
        });
    });

    it("returns focus to the thread's row when the dialog is cancelled", async () => {
        useThreadListUIStore.getState().setSnoozeThreadId("thread-b");
        render(
            <>
                <ListRows />
                <ListDialogs />
            </>,
        );

        // The keyboard or pointer puts focus on Cancel first; the close then moves it from that button to the thread's row.
        const cancel = screen.getByRole("button", { name: "Cancel" });

        cancel.focus();
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(cancel);

        fireEvent.click(cancel);

        await waitFor(() => {
            // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
            expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thread B" }));
        });
    });

    it("a thread that leaves the list while its dialog is open still gets focus back to the list", async () => {
        // The list removes the dialog before it clears the thread's id, so the id is still in the store when the return runs.
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        const list = document.createElement("div");

        list.tabIndex = -1;
        list.id = "list-root";
        document.body.appendChild(list);

        const Host = ({ present }: { present: boolean }) => (
            <>
                {present && (
                    <SnoozeUntilDialog
                        onOpenChange={() => {}}
                        open
                        previousUntil={undefined}
                        returnFocusTo={() => threadRowFocusTarget(list, "thread-a")}
                        threadId="thread-a"
                    />
                )}
            </>
        );
        const { rerender } = render(<Host present />);

        rerender(<Host present={false} />);

        await waitFor(() => {
            // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
            expect(document.activeElement).toBe(list);
        });
        expect(useThreadListUIStore.getState().snoozeThreadId).toBe("thread-a");
        list.remove();
    });

    it("a server-refused snooze shows the refused message and does not claim it may have saved", async () => {
        const onOpenChange = mountDialog();

        state.snoozeAt.mockResolvedValueOnce("refused");
        submit();

        const alert = await screen.findByRole("alert");

        // One error element, in the dialog's own error place, and not a second copy of it.
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(alert.textContent).toBe("Could not snooze the thread. Please try again.");
        expect(alert.textContent).not.toContain("may have");
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("shows that a save may have gone through when its answer was lost, and keeps the dialog open", async () => {
        const onOpenChange = mountDialog();

        state.snoozeAt.mockResolvedValueOnce("unconfirmed");
        submit();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Could not confirm the snooze. It may have saved; check the thread before saving again.");
        expect(onOpenChange).not.toHaveBeenCalled();
    });
});

describe("threadRowFocusTarget", () => {
    it("is the thread's row, or the list when the row has moved out of it", () => {
        render(
            <div data-testid="list">
                <div data-thread-id="thread-a" role="button" tabIndex={0}>
                    Thread A
                </div>
            </div>,
        );
        const list = screen.getByTestId("list");

        expect(threadRowFocusTarget(list, "thread-a")).toBe(screen.getByRole("button", { name: "Thread A" }));
        expect(threadRowFocusTarget(list, "thread-gone")).toBe(list);
        expect(threadRowFocusTarget(null, "thread-a")).toBeNull();
    });
});
