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
});
