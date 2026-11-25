/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what these tests assert */
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { FC } from "react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

import { useFocusFollowsPaneSwitch } from "./pane-switch-focus";

const PANES = ["first", "second"] as const;

/**
 * Two panes as the split view renders them: only the focused one has the header's control (a portal into the page's header
 * there). Focusing a pane's composer focuses the pane, as a click into a pane does; the page's switch button stands in for a
 * shortcut or a route change.
 */
const SplitView: FC = () => {
    const [focused, setFocused] = useState<string>("first");
    const containerRef = useRef<HTMLDivElement>(null);

    useFocusFollowsPaneSwitch(containerRef, focused);

    return (
        <>
            <button onClick={() => setFocused((current) => (current === "first" ? "second" : "first"))} type="button">
                Switch
            </button>
            <div ref={containerRef}>
                {PANES.map((id) => (
                    <section aria-label={`Pane ${id}`} data-pane-thread-id={id} key={id}>
                        {id === focused && (
                            <button
                                onKeyDown={(event) => {
                                    if (event.key === "s") {
                                        setFocused(id === "first" ? "second" : "first");
                                    }
                                }}
                                type="button"
                            >
                                {`Catch up ${id}`}
                            </button>
                        )}
                        <textarea aria-label={`Composer ${id}`} data-focus-area="composer" onFocus={() => setFocused(id)} />
                    </section>
                ))}
            </div>
        </>
    );
};

describe(useFocusFollowsPaneSwitch, () => {
    it("moves focus to the new pane's composer when the switch removes the focused header control", async () => {
        const user = userEvent.setup();

        render(<SplitView />);

        await user.click(screen.getByRole("button", { name: "Catch up first" }));
        await user.keyboard("s");

        expect(screen.queryByRole("button", { name: "Catch up first" })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Composer second" }));
    });

    it("leaves focus where the person clicked in the new pane", async () => {
        const user = userEvent.setup();

        render(<SplitView />);

        await user.click(screen.getByRole("button", { name: "Catch up first" }));
        await user.click(screen.getByRole("textbox", { name: "Composer second" }));

        expect(screen.queryByRole("button", { name: "Catch up first" })).toBeNull();

        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Composer second" }));
    });

    it("leaves focus on a control the switch did not remove", async () => {
        const user = userEvent.setup();

        render(<SplitView />);

        await user.click(screen.getByRole("button", { name: "Switch" }));

        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Switch" }));
    });
});
