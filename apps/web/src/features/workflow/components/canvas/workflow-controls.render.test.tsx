// @vitest-environment jsdom

/** The canvas toolbar is mostly icon-only buttons; each needs an accessible name of its own. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        deleteNode: () => {},
        duplicateNode: () => {},
        execution: { status: "completed" },
        groupNodes: () => {},
        isDirty: true,
        nodes: [
            { id: "a", selected: true, type: "http" },
            { id: "b", selected: true, type: "http" },
            { id: "c", selected: true, type: "http" },
        ],
        resetExecution: () => {},
        selectNode: () => {},
        setExecutionStatus: () => {},
    };
});

vi.mock("@lingui/core/macro", () => {
    return { msg: (strings: TemplateStringsArray) => strings[0] };
});

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("../../hooks/use-workflow-shortcuts", () => {
    return { alignSelectedNodes: () => {}, applyAutoLayout: () => {}, arrangeSelectedNodes: () => {}, distributeSelectedNodes: () => {} };
});

vi.mock("../../hooks/use-workflow-transfer", () => {
    return {
        useWorkflowTransfer: () => {
            return { exportWorkflow: () => {}, importWorkflow: () => {}, isTransferring: false };
        },
    };
});

vi.mock("../../stores/workflow-store", () => {
    const useWorkflowStore = (selector: (value: typeof state) => unknown) => selector(state);

    useWorkflowStore.getState = () => state;

    return { useWorkflowStore };
});

vi.mock("../../utils/auto-layout", () => {
    return { layoutSelection: (nodes: unknown[]) => nodes };
});

vi.mock("../../utils/validate-workflow", () => {
    return { detectCycles: () => [], validateNodes: () => [] };
});

vi.mock("../prompt-to-workflow-dialog", () => {
    return { default: () => null };
});

vi.mock("../template-picker", () => {
    return { default: () => null };
});

vi.mock("../version-history", () => {
    return { default: () => null };
});

const { default: WorkflowControls } = await import("./workflow-controls");

describe("WorkflowControls", () => {
    it.each([
        "Import workflow",
        "Export workflow",
        "Auto-layout",
        "Keyboard shortcuts",
        "Duplicate selected (3)",
        "Delete selected (3)",
        "Group (3)",
        "Align horizontally",
        "Align vertically",
        "Distribute evenly",
        "Arrange selection in a grid",
        "Show run history",
        "Reset execution state",
    ])("names the %s button", (name) => {
        render(<WorkflowControls onShowShortcuts={() => {}} onToggleHistory={() => {}} showHistory={false} />);

        expect(screen.getByRole("button", { name })).toBeTruthy();
    });

    it("flips the history label when the panel is open", () => {
        render(<WorkflowControls onToggleHistory={() => {}} showHistory />);

        expect(screen.getByRole("button", { name: "Hide run history" })).toBeTruthy();
    });
});
