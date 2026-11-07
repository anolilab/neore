// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { default: SnoozeUntilDialog } = await import("./snooze-until-dialog");

const mountDialog = (): ReturnType<typeof vi.fn> => {
    const onOpenChange = vi.fn();

    render(<SnoozeUntilDialog onOpenChange={onOpenChange} open previousUntil={undefined} returnFocusTo={() => null} threadId="t1" />);

    return onOpenChange;
};

const submit = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
};

describe("SnoozeUntilDialog when the send fails", () => {
    beforeEach(() => {
        state.snoozeAt.mockReset();
    });

    it("shows the error in the dialog, keeps Snooze and Cancel usable, and Cancel closes it", async () => {
        // An offline send is refused: the action reports it as a failed save, with the error toast already shown.
        state.snoozeAt.mockResolvedValueOnce(false);
        const onOpenChange = mountDialog();

        submit();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Could not snooze the thread. Please try again.");

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
