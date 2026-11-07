/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what these tests assert */

/**
 * The phone sheet of every responsive dialog (`@neore/ui/components/drawer`): on screen, and holding focus. It sat
 * in the page flow below a full-height page (its classes said `fixed relative`, and `relative` won), and with vaul's
 * auto-focus off nothing inside it was focused, so its focus trap never engaged.
 */
import { Drawer, DrawerContent, DrawerTitle } from "@neore/ui/components/drawer";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const sheet = () => (
    <Drawer open>
        <DrawerContent>
            <DrawerTitle>Sign in</DrawerTitle>
            <button type="button">Inside</button>
        </DrawerContent>
    </Drawer>
);

describe("DrawerContent", () => {
    it("is positioned fixed, not in the page flow", async () => {
        render(sheet());

        const content = await screen.findByRole("dialog");

        expect(content.className.split(" ")).toContain("fixed");
        expect(content.className.split(" ")).not.toContain("relative");
    });

    it("takes focus when it opens, so Tab stays inside it", async () => {
        render(
            <>
                <button type="button">Behind</button>
                {sheet()}
            </>,
        );

        const content = await screen.findByRole("dialog");

        // The sheet itself, not a field: a phone's keyboard should not jump up.
        await waitFor(() => {
            expect(document.activeElement).toBe(content);
        });
    });
});
