// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RenameThreadDialog from "./rename-thread-dialog";

// The rename's own action: each test decides whether it succeeds.
const writes = vi.hoisted(() => {
    return {
        rename: vi.fn(async (_variables: unknown) => {
            return {};
        }),
    };
});

const showError = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { chat: { functions: { updateThread: {} } } } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return { mutationFn: (variables: unknown) => writes.rename(variables) };
        },
    };
});

vi.mock("@/features/chat/core/stores/thread-store-hooks", () => {
    return {
        useThreadActions: () => {
            return { setThreadMetadata: () => {} };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError };
});

/**
 * The list's shape: the dialog is mounted only while it is open, and unmounted on close, as `HierarchicalThreadList` does. A
 * second writer (the header's title edit) shares the query client but none of the dialog's state.
 */
const Harness = ({ headerWrite }: { headerWrite: () => Promise<unknown> }) => {
    const [open, setOpen] = useState(true);
    const header = useMutation({ mutationFn: headerWrite, retry: 0 });

    return (
        <>
            {open && <RenameThreadDialog onOpenChange={setOpen} open storedTitle="Old" threadId="thread-1" />}
            <button onClick={() => header.mutate(undefined)} type="button">
                Header write
            </button>
            <span data-testid="closed">{open ? "open" : "closed"}</span>
        </>
    );
};

const renderHarness = (
    headerWrite: () => Promise<unknown> = async () => {
        return {};
    },
) => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });

    return render(
        <QueryClientProvider client={client}>
            <Harness headerWrite={headerWrite} />
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    showError.mockClear();
    writes.rename.mockReset();
    writes.rename.mockResolvedValue({});
});

describe("the rename's status", () => {
    it("reports the rename as saved and shows no failure, when a later header write fails", async () => {
        writes.rename.mockResolvedValueOnce({});

        renderHarness(async () => {
            throw new Error("header write refused");
        });

        fireEvent.change(screen.getByDisplayValue("Old"), { target: { value: "New" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(screen.getByTestId("closed").textContent).toBe("closed"));

        const headerWrite = screen.getByRole("button", { name: "Header write" });

        fireEvent.click(headerWrite);
        await waitFor(() => expect(writes.rename).toHaveBeenCalledTimes(1));

        // The rename's dialog is closed and nothing says it failed; the header's error is its own.
        expect(screen.queryByText("The title could not be saved. Try again.")).toBeNull();
        expect(showError).not.toHaveBeenCalled();
        expect(writes.rename).toHaveBeenCalledTimes(1);
    });

    it("reports a rename that fails after Cancel, though the dialog is already gone", async () => {
        // The rename is refused a moment after Save, which is after Cancel has closed the dialog.
        writes.rename.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    setTimeout(() => reject(new Error("refused")), 20);
                }),
        );

        renderHarness();

        fireEvent.change(screen.getByDisplayValue("Old"), { target: { value: "New" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(writes.rename).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByDisplayValue("New")).toBeNull());

        await waitFor(() => expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: "refused" })));
    });

    it("moves focus into the title input when the dialog opens", async () => {
        renderHarness();

        const input = screen.getByDisplayValue("Old");

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(input));
    });
});
