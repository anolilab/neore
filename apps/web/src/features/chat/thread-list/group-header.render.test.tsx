// @vitest-environment jsdom

/** A project group's actions trigger is a three-dot icon; it must carry its own accessible name. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

const TODAY_NAME = /Today/u;
const NEEDS_YOU_NAME = /Needs you/u;

const { default: GroupHeader } = await import("./group-header");

describe("GroupHeader", () => {
    it("names the project actions button", () => {
        render(
            <GroupHeader
                group={{ groupType: "project", projectId: "p1", threads: [], title: "Docs" }}
                groupThreadIds={[]}
                isCollapsed={false}
                isSelectionMode={false}
                onToggleCollapse={() => {}}
                onToggleSelection={() => {}}
                selectedThreadIds={new Set()}
            />,
        );

        expect(screen.getByRole("button", { name: "Actions for project Docs" })).toBeTruthy();
    });

    const baseProps = {
        groupThreadIds: [],
        isCollapsed: false,
        isSelectionMode: false,
        onToggleCollapse: () => {},
        onToggleSelection: () => {},
        selectedThreadIds: new Set<string>(),
    };

    it("shows the thread count as a bare number and keeps the collapse toggle's state", () => {
        const thread = { branchPoint: 0, branchType: "root", children: [], createdAt: 0, depth: 0, status: "idle", threadId: "t1", title: "One" };

        const { rerender } = render(
            <GroupHeader {...baseProps} group={{ groupType: "today", threads: [thread, { ...thread, threadId: "t2" }], title: "Today" }} />,
        );

        // The count is a bare number on screen; a hidden comma keeps the spoken name "Today, 2".
        expect(screen.getByRole("button", { expanded: true, name: TODAY_NAME }).textContent).toBe("Today, 2");
        expect(screen.getByRole("button", { name: "Today, 2" })).toBeTruthy();

        rerender(<GroupHeader {...baseProps} group={{ groupType: "today", threads: [thread], title: "Today" }} isCollapsed />);

        expect(screen.getByRole("button", { expanded: false, name: TODAY_NAME })).toBeTruthy();
    });

    it("colours the Needs you group's label with the attention token, and no other group's", () => {
        const { rerender } = render(<GroupHeader {...baseProps} group={{ groupType: "needsYou", isPlaceholder: true, threads: [], title: "Needs you" }} />);

        expect(screen.getByRole("button", { name: NEEDS_YOU_NAME }).parentElement?.classList.contains("text-attention")).toBe(true);

        rerender(<GroupHeader {...baseProps} group={{ groupType: "today", threads: [], title: "Today" }} />);

        expect(screen.getByRole("button", { name: TODAY_NAME }).parentElement?.classList.contains("text-attention")).toBe(false);
    });
});
