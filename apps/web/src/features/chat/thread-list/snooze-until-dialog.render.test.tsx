// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadListUIStore } from "./stores/thread-list-ui-store";

const state = vi.hoisted(() => {
    return { snoozeAt: vi.fn<(threadId: string, until: number, previousUntil: number | undefined) => Promise<boolean>>() };
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

const { default: SnoozeUntilDialog, closeSnoozeDialogFor } = await import("./snooze-until-dialog");

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
        state.snoozeAt.mockResolvedValueOnce(false);
        const onOpenChange = mountDialog();
        const chosen = localInput(new Date(Date.now() + 2 * 60 * 60 * 1000));

        fireEvent.change(wakeInput(), { target: { value: chosen } });
        submit();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Could not snooze the thread. Please try again.");
        expect(wakeInput().value).toBe(chosen);

        const snooze = screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement;

        expect(snooze.disabled).toBe(false);
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(snooze);
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("lets Cancel close the dialog while a send that never settles is still pending", async () => {
        state.snoozeAt.mockReturnValueOnce(new Promise<boolean>(() => {}));
        const onOpenChange = mountDialog();

        submit();

        expect(await screen.findByText("Saving…")).toBeTruthy();

        const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

        expect(cancel.disabled).toBe(false);

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
            returnFocusTo={() => null}
            threadId={threadId}
        />
    );
};

describe("the list's snooze dialog across threads", () => {
    beforeEach(() => {
        state.snoozeAt.mockReset();
        useThreadListUIStore.getState().setSnoozeThreadId(null);
    });

    it("a save for thread A that finishes after thread B's dialog opened leaves B's dialog open", async () => {
        // A's save stays in flight until the test releases it, after B's dialog has opened.
        let released = false;

        state.snoozeAt.mockImplementationOnce(
            async () =>
                await new Promise<boolean>((resolve) => {
                    const poll = setInterval(() => {
                        if (!released) {
                            return;
                        }

                        clearInterval(poll);
                        resolve(true);
                    }, 5);
                }),
        );
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(<ListDialogs />);

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
        expect(await screen.findByText("Saving…")).toBeTruthy();

        // The owner opens another thread's snooze while A's save is still in flight.
        act(() => {
            useThreadListUIStore.getState().setSnoozeThreadId("thread-b");
        });

        released = true;

        await act(async () => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 50);
            });
        });

        expect(useThreadListUIStore.getState().snoozeThreadId).toBe("thread-b");
        expect(screen.getByLabelText("Wake up at")).toBeTruthy();
    });

    it("a save that finishes for the thread still open closes its dialog", async () => {
        state.snoozeAt.mockResolvedValueOnce(true);
        useThreadListUIStore.getState().setSnoozeThreadId("thread-a");
        render(<ListDialogs />);

        fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

        await act(async () => {
            await Promise.resolve();
        });

        expect(useThreadListUIStore.getState().snoozeThreadId).toBeNull();
    });
});
