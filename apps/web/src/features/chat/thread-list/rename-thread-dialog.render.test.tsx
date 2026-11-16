// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, RefObject } from "react";
import { createRef, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { renameFocusTarget } from "./rename-focus-target";
import RenameThreadDialog from "./rename-thread-dialog";

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

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: () => {} };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {};
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
    return { showError: () => {} };
});

/**
 * The list's shape around the dialog: a root that stays mounted, a row with an options trigger, and the dialog as a sibling of
 * the rows, mounted while open, the way `HierarchicalThreadList` mounts it.
 */
const List = ({ children, root }: { children?: ReactNode; root: RefObject<HTMLDivElement | null> }) => (
    <div ref={root} tabIndex={-1}>
        {children}
    </div>
);

const Row = () => (
    <div data-thread-id="thread-1">
        <button type="button">Thread options</button>
    </div>
);

describe("RenameThreadDialog focus return", () => {
    it("returns focus to the row when it is still mounted after the dialog closes", async () => {
        const root = createRef<HTMLDivElement>();
        const restoreFocus = () => renameFocusTarget(root.current, "thread-1");

        const { rerender } = render(
            <List root={root}>
                <Row />
                <RenameThreadDialog onOpenChange={() => {}} open restoreFocus={restoreFocus} storedTitle="Chat" threadId="thread-1" />
            </List>,
        );

        rerender(
            <List root={root}>
                <Row />
            </List>,
        );

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(root.current?.querySelector('[data-thread-id="thread-1"]')));
    });

    it("falls back to the list root when virtualization unmounts the row while the dialog is open", async () => {
        const root = createRef<HTMLDivElement>();
        const restoreFocus = () => renameFocusTarget(root.current, "thread-1");

        const { rerender } = render(
            <List root={root}>
                <Row />
                <RenameThreadDialog onOpenChange={() => {}} open restoreFocus={restoreFocus} storedTitle="Chat" threadId="thread-1" />
            </List>,
        );

        // The row, and its options trigger with it, leave the list while the dialog stays open.
        rerender(
            <List root={root}>
                <RenameThreadDialog onOpenChange={() => {}} open restoreFocus={restoreFocus} storedTitle="Chat" threadId="thread-1" />
            </List>,
        );

        // The dialog closes: the parent unmounts it.
        rerender(<List root={root} />);

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        await waitFor(() => expect(document.activeElement).toBe(root.current));
    });

    it("keeps focus in the open dialog's input when StrictMode replays its effects", async () => {
        const root = createRef<HTMLDivElement>();
        const restoreFocus = () => renameFocusTarget(root.current, "thread-1");

        render(
            <StrictMode>
                <List root={root}>
                    <Row />
                    <RenameThreadDialog onOpenChange={() => {}} open restoreFocus={restoreFocus} storedTitle="Chat" threadId="thread-1" />
                </List>
            </StrictMode>,
        );

        // The replay's restore runs after a turn; the input must still hold the focus once it has.
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(screen.getByLabelText("Title"));
    });
});
