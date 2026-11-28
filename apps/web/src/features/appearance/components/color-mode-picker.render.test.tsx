// @vitest-environment jsdom

/** The color mode picker: System, Light and Dark as radio tiles on the same theme state as the header toggle. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

const theme = vi.hoisted(() => {
    return { setTheme: vi.fn(), theme: "dark" as string | undefined };
});

vi.mock("next-themes", () => {
    return { useTheme: () => theme };
});

const { default: ColorModePicker } = await import("./color-mode-picker");

describe("ColorModePicker", () => {
    beforeEach(() => {
        theme.setTheme.mockClear();
        theme.theme = "dark";
    });

    it("lists System, Light and Dark as one named radio group, with the current theme checked", () => {
        render(<ColorModePicker />);

        expect(screen.getByRole("radiogroup", { name: "Color mode" })).toBeTruthy();
        expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
        expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    });

    it("sets the theme to the clicked tile", () => {
        render(<ColorModePicker />);

        fireEvent.click(screen.getByRole("radio", { name: "Light" }));
        expect(theme.setTheme).toHaveBeenCalledWith("light");

        fireEvent.click(screen.getByRole("radio", { name: "System" }));
        expect(theme.setTheme).toHaveBeenCalledWith("system");
    });

    it("shows System before the theme is known", () => {
        theme.theme = undefined;
        render(<ColorModePicker />);

        expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    });
});
