/**
 * "Keep as mine" on a chat's variable an admin wrote: the badge sits on that value only, the keep sends the stored value
 * (the server refuses one changed since) and waits while the field shows an unsaved edit or a save is in flight, and the
 * row's refresh after the keep leaves unsaved edits in place.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ThreadVariablesConfig from "./thread-variables-config";

type Row = { threadId: string; userId: string; variables: { name: string; value: string }[]; variablesByImpersonator?: string[] };

const harness = vi.hoisted(() => {
    return {
        keep: vi.fn(async (_args: unknown) => null),
        // A save that never settles, so the panel stays "saving".
        save: vi.fn(async (_args: unknown) => await new Promise<null>(() => {})),
        listeners: new Set<() => void>(),
        row: undefined as Row | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: {}, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonationState: () => "self" };
});

// The scroll area measures with a ResizeObserver jsdom lacks; its contents are what matter here.
vi.mock("@neore/ui/components/scroll-area", () => {
    return { ScrollArea: ({ children }: { children: unknown }) => children };
});

vi.mock("../lib/prompt-variables", () => {
    return {
        getCommonVariableCategories: () => {
            return {};
        },
        isSystemManagedVariable: () => false,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                prompts: {
                    functions: {
                        getThreadVariables: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                        keepVariableValue: {
                            mutationOptions: () => {
                                return { mutationFn: harness.keep };
                            },
                        },
                        setThreadVariables: {
                            mutationOptions: () => {
                                return { mutationFn: harness.save };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@tanstack/react-query", async () => {
    const { useSyncExternalStore } = await import("react");

    return {
        useMutation: (options: { mutationFn: (args: unknown) => Promise<unknown> }) => {
            return { mutateAsync: options.mutationFn };
        },
        useQuery: () => {
            const data = useSyncExternalStore(
                (listener) => {
                    harness.listeners.add(listener);

                    return () => harness.listeners.delete(listener);
                },
                () => harness.row,
            );

            return { data };
        },
    };
});

const push = (row: Row) => {
    harness.row = row;

    for (const listener of harness.listeners) {
        listener();
    }
};

afterEach(() => {
    cleanup();
    harness.keep.mockClear();
    harness.save.mockClear();
});

describe("ThreadVariablesConfig's admin marks", () => {
    it("marks only the value an admin wrote, keeps it with the stored value, and leaves unsaved edits after the refresh", async () => {
        const values = [
            { name: "site", value: "bank" },
            { name: "who", value: "Ann" },
        ];

        harness.row = { threadId: "t1", userId: "u1", variables: values, variablesByImpersonator: ["site"] };
        render(<ThreadVariablesConfig threadId="t1" />);

        expect(screen.getAllByText("Changed by an admin")).toHaveLength(1);

        const [site, who] = screen.getAllByPlaceholderText("Enter value...") as HTMLInputElement[];
        const keep = () => screen.getByRole("button", { name: "Keep as mine: site" }) as HTMLButtonElement;

        // An unsaved edit of the marked value: the stored value is no longer on screen, so the keep waits.
        fireEvent.change(site!, { target: { value: "bank2" } });
        expect(keep().disabled).toBe(true);
        expect(screen.getByText("Save or undo your change first.")).toBeTruthy();

        // Undone, it keeps the value shown, which is the stored one; another field's edit does not hold it.
        fireEvent.change(site!, { target: { value: "bank" } });
        fireEvent.change(who!, { target: { value: "Bob" } });
        expect(keep().disabled).toBe(false);
        fireEvent.click(keep());

        await waitFor(() => {
            expect(harness.keep).toHaveBeenCalledWith({ name: "site", scope: "thread", threadId: "t1", value: "bank" });
        });

        // The server's push: same values, no marks.
        act(() => {
            push({ threadId: "t1", userId: "u1", variables: values });
        });

        expect(screen.queryByText("Changed by an admin")).toBeNull();
        expect((screen.getAllByPlaceholderText("Enter value...") as HTMLInputElement[]).map((input) => input.value)).toEqual(["bank", "Bob"]);
    });

    it("holds the keep while a save of the panel is in flight", () => {
        harness.row = {
            threadId: "t1",
            userId: "u1",
            variables: [
                { name: "site", value: "bank" },
                { name: "who", value: "Ann" },
            ],
            variablesByImpersonator: ["site"],
        };
        render(<ThreadVariablesConfig threadId="t1" />);

        fireEvent.change(screen.getAllByPlaceholderText("Enter value...")[1]!, { target: { value: "Bob" } });
        fireEvent.click(screen.getByRole("button", { name: "Save Variables" }));

        expect((screen.getByRole("button", { name: "Keep as mine: site" }) as HTMLButtonElement).disabled).toBe(true);
        expect(harness.keep).not.toHaveBeenCalled();
    });
});
