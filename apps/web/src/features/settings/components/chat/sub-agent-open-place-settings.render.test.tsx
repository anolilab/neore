import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import SubAgentOpenPlaceSettings from "./sub-agent-open-place-settings";

// The unit-test transform does not compile Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const HOLD_HINT_RE = /Hold Ctrl, Cmd or the middle mouse button to open it in the other place/u;

const setSubAgentOpenPlace = (subAgentOpenPlace: "main" | "side") => {
    useUIStateStore.setState((state) => {
        return { preferences: { ...state.preferences, subAgentOpenPlace } };
    });
};

describe("where a sub-agent or side chat opens", () => {
    beforeEach(() => {
        // The select positions its popup with a ResizeObserver, which jsdom lacks.
        vi.stubGlobal(
            "ResizeObserver",
            class {
                disconnect = vi.fn();

                observe = vi.fn();

                unobserve = vi.fn();
            },
        );
        setSubAgentOpenPlace("side");
    });

    it("shows the side panel by default, with what Ctrl, Cmd and the middle button do", () => {
        render(<SubAgentOpenPlaceSettings />);

        expect(screen.getByRole("combobox", { name: "Where a sub-agent or side chat opens" }).textContent).toContain("Side panel");
        expect(screen.getByText(HOLD_HINT_RE)).toBeTruthy();
    });

    it("shows the main view when that is the saved setting", () => {
        setSubAgentOpenPlace("main");

        render(<SubAgentOpenPlaceSettings />);

        expect(screen.getByRole("combobox", { name: "Where a sub-agent or side chat opens" }).textContent).toContain("Main view");
    });

    it("saves the main view when it is picked", async () => {
        const user = userEvent.setup();

        render(<SubAgentOpenPlaceSettings />);

        await user.click(screen.getByRole("combobox", { name: "Where a sub-agent or side chat opens" }));
        await user.click(await screen.findByRole("option", { name: "Main view" }));

        expect(useUIStateStore.getState().preferences.subAgentOpenPlace).toBe("main");
        expect(screen.getByRole("combobox", { name: "Where a sub-agent or side chat opens" }).textContent).toContain("Main view");
    });
});
