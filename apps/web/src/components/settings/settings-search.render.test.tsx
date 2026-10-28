import { Dialog, DialogContent, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FC } from "react";
import { useMemo } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { SettingsTab } from "@/features/settings/lib/settings-navigation";
import { resolveSettingsNavigation } from "@/features/settings/lib/settings-navigation";
import type { SettingsSearchEntry } from "@/features/settings/lib/settings-search";

import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from "./settings-search";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
        plural: (count: number) => `${String(count)} ${count === 1 ? "result" : "results"}`,
    };
});

vi.mock("@lingui/react/macro", () => {
    // Called with a descriptor by the search index, as a tag by the components.
    const t = (first: TemplateStringsArray | { id: string }, ...values: unknown[]) =>
        "id" in first ? first.id : String.raw({ raw: first as TemplateStringsArray }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t };
        },
    };
});

const NO_LOCKED_TABS: ReadonlySet<SettingsTab> = new Set();
const everyTab = { activeOrganization: true, apiKey: true, organization: true };

const onSelect = vi.fn<(entry: SettingsSearchEntry) => void>();
const onPreview = vi.fn<(tab: SettingsTab) => void>();
const onEscapeReachedDialog = vi.fn();

const Harness: FC<{ lockedTabs?: ReadonlySet<SettingsTab> }> = ({ lockedTabs = NO_LOCKED_TABS }) => {
    const navigation = useMemo(() => resolveSettingsNavigation(everyTab, (descriptor) => descriptor.id ?? ""), []);
    const search = useSettingsSearch(navigation);

    return (
        // Stands in for the dialog: an Escape that bubbles this far would close the modal.
        <div
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    onEscapeReachedDialog();
                }
            }}
            role="presentation"
        >
            <SettingsSearchField
                activeIndex={search.activeIndex}
                isSearching={search.isSearching}
                listboxId={search.listboxId}
                onActivate={() => search.activeEntry && onSelect(search.activeEntry)}
                onMove={search.moveActive}
                optionId={search.optionId}
                query={search.query}
                resultCount={search.resultCount}
                setQuery={search.setQuery}
            />
            <SettingsSearchResults
                activeIndex={search.activeIndex}
                groups={search.groups}
                isSearching={search.isSearching}
                listboxId={search.listboxId}
                lockedTabs={lockedTabs}
                onPreview={onPreview}
                onSelect={onSelect}
                optionId={search.optionId}
                setActive={search.setActive}
            />
        </div>
    );
};

const type = (value: string) => {
    fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value } });
};

const press = (key: string) => {
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search settings" }), { key });
};

const selectedOption = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

describe("settings search combobox", () => {
    it("is collapsed with nothing typed and exposes a listbox once there are results", () => {
        render(<Harness />);

        const field = screen.getByRole("combobox", { name: "Search settings" });

        expect(field.getAttribute("aria-expanded")).toBe("false");
        expect(field.hasAttribute("aria-controls")).toBe(false);
        expect(screen.queryByRole("listbox")).toBeNull();

        type("model");

        const listbox = screen.getByRole("listbox", { name: "Settings search results" });

        expect(field.getAttribute("aria-expanded")).toBe("true");
        expect(field.getAttribute("aria-controls")).toBe(listbox.id);
        expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(1);
        expect(within(listbox).getAllByRole("group").length).toBeGreaterThan(0);
    });

    it("points aria-activedescendant at the one selected option, the first to start with", () => {
        render(<Harness />);
        type("model");

        const field = screen.getByRole("combobox", { name: "Search settings" });
        const selected = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");

        expect(selected).toHaveLength(1);
        expect(selected[0]).toBe(screen.getAllByRole("option")[0]);
        expect(field.getAttribute("aria-activedescendant")).toBe(selected[0]?.id);
    });

    it("moves the selection with the arrow keys and wraps at both ends", () => {
        render(<Harness />);
        type("model");

        const options = screen.getAllByRole("option");
        const field = screen.getByRole("combobox", { name: "Search settings" });

        press("ArrowDown");
        expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
        expect(selectedOption()).toBe(options[1]);

        press("ArrowUp");
        press("ArrowUp");
        expect(selectedOption()).toBe(options.at(-1));

        press("ArrowDown");
        expect(selectedOption()).toBe(options[0]);
    });

    it("starts from the first result again for a new query", () => {
        render(<Harness />);
        type("model");
        press("ArrowDown");
        type("models");

        expect(selectedOption()).toBe(screen.getAllByRole("option")[0]);
    });

    it("opens the selected result on Enter, and only when there is one", () => {
        onSelect.mockClear();
        render(<Harness />);

        press("Enter");
        expect(onSelect).not.toHaveBeenCalled();

        type("model");
        press("ArrowDown");
        press("Enter");

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(selectedOption()?.textContent).toContain(onSelect.mock.calls[0]?.[0].label);
    });

    it("opens a result by clicking it", () => {
        onSelect.mockClear();
        render(<Harness />);
        type("model");
        fireEvent.click(screen.getAllByRole("option")[2] as HTMLElement);

        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("clears the query on the first Escape and lets the second one through to the dialog", () => {
        onEscapeReachedDialog.mockClear();
        render(<Harness />);
        type("model");

        press("Escape");

        const field = screen.getByRole("combobox", { name: "Search settings" });

        expect((field as HTMLInputElement).value).toBe("");
        expect(onEscapeReachedDialog).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).toBeNull();

        press("Escape");

        expect(onEscapeReachedDialog).toHaveBeenCalledTimes(1);
    });

    it("announces the count in a polite live region, and nothing for an empty query", () => {
        render(<Harness />);

        const status = screen.getByRole("status");

        expect(status.getAttribute("aria-live")).toBe("polite");
        expect(status.textContent).toBe("");

        type("model");
        expect(status.textContent).toBe(`${String(screen.getAllByRole("option").length)} results`);

        type("zzzz-no-such-setting");
        expect(status.textContent).toBe("0 results");
        expect(screen.getByRole("combobox", { name: "Search settings" }).getAttribute("aria-expanded")).toBe("false");
        expect(screen.getByText("No results")).toBeTruthy();
    });

    it("marks results of a tab a guest cannot open, for sighted and screen-reader users", () => {
        render(<Harness lockedTabs={new Set<SettingsTab>(["chat-agent"])} />);
        type("agent");

        const locked = screen.getAllByRole("option").filter((option) => option.textContent?.includes("Requires an account"));

        expect(locked.length).toBeGreaterThan(0);
        expect(locked.every((option) => option.textContent?.includes("Agent"))).toBe(true);
    });

    it("previews a tab's chunk when its result is hovered", () => {
        onPreview.mockClear();
        render(<Harness />);
        type("model");
        fireEvent.mouseEnter(screen.getAllByRole("option")[1] as HTMLElement);

        expect(onPreview).toHaveBeenCalledTimes(1);
        expect(selectedOption()).toBe(screen.getAllByRole("option")[1]);
    });
});

describe("settings search inside the dialog", () => {
    it("keeps the dialog open for the Escape that clears the query and closes it on the next", () => {
        const onOpenChange = vi.fn();

        render(
            <Dialog onOpenChange={onOpenChange} open>
                <DialogContent>
                    <DialogTitle>Settings</DialogTitle>
                    <Harness />
                </DialogContent>
            </Dialog>,
        );
        type("model");

        press("Escape");
        expect(onOpenChange).not.toHaveBeenCalled();
        expect((screen.getByRole("combobox", { name: "Search settings" }) as HTMLInputElement).value).toBe("");

        press("Escape");
        expect(onOpenChange).toHaveBeenCalledTimes(1);
        expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
    });
});
