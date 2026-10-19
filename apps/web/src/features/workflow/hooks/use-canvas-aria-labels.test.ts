import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCanvasAriaLabels } from "./use-canvas-aria-labels";

// Unit tests do not compile the Lingui macros: `t` is a plain tag that interpolates its values.
vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.reduce((out, part, i) => out + part + (i < values.length ? String(values[i]) : ""), "");

    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t };
        },
    };
});

describe("useCanvasAriaLabels", () => {
    it("localizes every string key of the installed React Flow config", () => {
        const { result } = renderHook(() => useCanvasAriaLabels());

        const stringKeys = Object.keys(result.current).filter((key) => key !== "node.a11yDescription.ariaLiveMessage");

        expect(stringKeys).toHaveLength(10);

        for (const key of stringKeys) {
            expect(result.current[key as keyof typeof result.current]).toEqual(expect.any(String));
        }
    });

    it("formats the live message with the localized direction", () => {
        const { result } = renderHook(() => useCanvasAriaLabels());

        const message = result.current["node.a11yDescription.ariaLiveMessage"]({ direction: "left", x: 10, y: -4 });

        expect(message).toBe("Moved selected node left. New position, x: 10, y: -4");
    });

    it("returns the same object across renders in the same locale", () => {
        const { result, rerender } = renderHook(() => useCanvasAriaLabels());
        const first = result.current;

        rerender();

        expect(result.current).toBe(first);
    });
});
