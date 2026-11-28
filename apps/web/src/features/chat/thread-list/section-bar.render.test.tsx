// @vitest-environment jsdom

/** The section bar: counts from the loaded rows, one section on a click, several on a shift-click, never none. */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/native/bridge", () => {
    return { getAddProjectBridge: () => undefined };
});

const { default: SectionBar } = await import("./section-bar");
const { useThreadListUIStore } = await import("./stores/thread-list-ui-store");

const counts = { active: 9, archived: 48, needsYou: 1, snoozed: 3, working: 1 };

const pressed = () =>
    screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.getAttribute("aria-label"));

describe("SectionBar", () => {
    beforeEach(() => {
        localStorage.clear();
        useThreadListUIStore.getState().reset();
        act(() => {
            useThreadListUIStore.getState().setSectionCounts(counts);
        });
    });

    it("names each section with its count, as a group, with Active pressed by default", () => {
        render(<SectionBar />);

        expect(screen.getByRole("group", { name: "Thread sections (shift-click to show several)" })).toBeTruthy();

        for (const name of ["Active, 9", "Needs you, 1", "Working, 1", "Snoozed, 3", "Archived, 48"]) {
            expect(screen.getByRole("button", { name })).toBeTruthy();
        }

        expect(pressed()).toEqual(["Active, 9"]);
    });

    it("shows only the clicked section", () => {
        render(<SectionBar />);

        fireEvent.click(screen.getByRole("button", { name: "Archived, 48" }));

        expect(pressed()).toEqual(["Archived, 48"]);
        expect(useThreadListUIStore.getState().sectionFilter).toEqual(["archived"]);
    });

    it("adds a section on a shift-click, takes it out on another, and never ends up with none", () => {
        render(<SectionBar />);

        fireEvent.click(screen.getByRole("button", { name: "Working, 1" }), { shiftKey: true });

        expect(pressed()).toEqual(["Active, 9", "Working, 1"]);

        fireEvent.click(screen.getByRole("button", { name: "Active, 9" }), { shiftKey: true });
        fireEvent.click(screen.getByRole("button", { name: "Working, 1" }), { shiftKey: true });

        expect(pressed()).toEqual(["Working, 1"]);
    });

    it("leaves out Needs you and Snoozed while nothing is in them, unless the filter still names them", () => {
        act(() => {
            useThreadListUIStore.getState().setSectionCounts({ ...counts, needsYou: 0, snoozed: 0 });
        });
        const { unmount } = render(<SectionBar />);

        expect(screen.queryByRole("button", { name: "Needs you, 0" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Snoozed, 0" })).toBeNull();
        expect(screen.getByRole("button", { name: "Working, 1" })).toBeTruthy();
        unmount();

        act(() => {
            useThreadListUIStore.getState().setSectionFilter(["snoozed"]);
        });
        render(<SectionBar />);

        expect(screen.getByRole("button", { name: "Snoozed, 0" })).toBeTruthy();
    });

    it("drops the selection and its shift-click anchor on a section switch, so a range cannot start from the old section's rows", () => {
        act(() => {
            useThreadListUIStore.setState({ lastSelectedIndex: 4, selectedThreadIds: new Set(["t1"]) });
        });
        render(<SectionBar />);

        fireEvent.click(screen.getByRole("button", { name: "Working, 1" }));

        const { lastSelectedIndex, selectedThreadIds } = useThreadListUIStore.getState();

        expect(lastSelectedIndex).toBe(-1);
        expect(selectedThreadIds.size).toBe(0);
    });

    it("is hidden while a search is typed", () => {
        render(<SectionBar />);

        act(() => {
            useThreadListUIStore.getState().setSearchQuery("budget");
        });

        expect(screen.queryByRole("group", { name: "Thread sections (shift-click to show several)" })).toBeNull();

        act(() => {
            useThreadListUIStore.getState().setSearchQuery("");
        });

        expect(screen.getByRole("group", { name: "Thread sections (shift-click to show several)" })).toBeTruthy();
    });

    it("keeps the choice for the next visit, read after mount", async () => {
        const { unmount } = render(<SectionBar />);

        fireEvent.click(screen.getByRole("button", { name: "Snoozed, 3" }));
        unmount();

        const saved = localStorage.getItem("thread-list-sections");

        expect(saved).toContain("snoozed");

        // A new visit: the store starts from its default, and the saved choice is read once the bar is mounted.
        localStorage.setItem("thread-list-sections", saved ?? "");
        act(() => {
            useThreadListUIStore.setState({ sectionFilter: ["active"] });
        });
        localStorage.setItem("thread-list-sections", saved ?? "");

        render(<SectionBar />);
        await act(async () => {
            await useThreadListUIStore.persist.rehydrate();
        });

        expect(pressed()).toEqual(["Snoozed, 3"]);
    });

    it("keeps the choice made this visit when storage is blocked and the bar mounts again", async () => {
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });

        try {
            const { unmount } = render(<SectionBar />);

            fireEvent.click(screen.getByRole("button", { name: "Snoozed, 3" }));
            unmount();

            render(<SectionBar />);
            await act(async () => {
                await useThreadListUIStore.persist.rehydrate();
            });

            expect(pressed()).toEqual(["Snoozed, 3"]);
        } finally {
            getItem.mockRestore();
        }
    });

    it("falls back to Active for a saved choice that names nothing known", async () => {
        localStorage.setItem("thread-list-sections", JSON.stringify({ state: { sectionFilter: ["gone"] }, version: 1 }));
        render(<SectionBar />);
        await act(async () => {
            await useThreadListUIStore.persist.rehydrate();
        });

        expect(pressed()).toEqual(["Active, 9"]);
    });
});
