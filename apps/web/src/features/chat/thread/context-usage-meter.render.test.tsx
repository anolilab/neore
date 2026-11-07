import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ContextUsageMeter from "./context-usage-meter";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted): the plural picks its form the way the locale's rules do
// for English, and the message is the source text with its values in place.
vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

describe("the context meter's token count", () => {
    it("uses the singular noun for a count of one", () => {
        render(<ContextUsageMeter contextWindow={200} usedTokens={1} />);

        expect(screen.getByRole("button", { name: "1/200 token used (0.5%)" })).toBeTruthy();
    });

    it("does not animate the ring's stroke for a user who prefers reduced motion", () => {
        render(<ContextUsageMeter contextWindow={200} usedTokens={2} />);
        // eslint-disable-next-line testing-library/no-node-access -- the ring is a plain SVG circle, which no query finds by role or text
        const rings = [...screen.getByRole("button").querySelectorAll("circle")];
        const ring = rings.find((circle) => circle.getAttribute("class")?.includes("transition-["));

        expect(ring?.getAttribute("class")).toContain("motion-reduce:transition-none");
    });

    it("uses the plural noun for any other count", () => {
        render(<ContextUsageMeter contextWindow={200} usedTokens={2} />);

        expect(screen.getByRole("button", { name: "2/200 tokens used (1.0%)" })).toBeTruthy();
    });
});
