/**
 * A task run that started from a fresh context leaves a divider that says earlier messages were not sent.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ContextResetDivider from "./context-reset-divider";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

describe("ContextResetDivider", () => {
    it("is a separator saying the earlier messages were not sent to the model", () => {
        render(<ContextResetDivider />);

        expect(screen.getByRole("separator").getAttribute("aria-label")).toBe("New task run · earlier messages were not sent to the model");
    });
});
