// @vitest-environment jsdom

/**
 * The reasoning block's footer: copy the reasoning text, and collapse from below
 * the text with focus handed back to the trigger. Asserted through roles and text.
 */

import { Reasoning, ReasoningContent, ReasoningTrigger } from "@neore/ui/components/ai-elements/reasoning";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: String.raw({ raw: strings }) };
        },
    };
});
vi.mock("@lingui/react/macro", () => {
    return {
        Plural: () => null,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id },
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

const TEXT = "First I considered the options.";

const Harness = ({ isStreaming = false }: { isStreaming?: boolean }) => {
    const [open, setOpen] = useState(true);

    return (
        <Reasoning defaultOpen={false} isStreaming={isStreaming} onOpenChange={setOpen} open={open}>
            <ReasoningTrigger />
            <ReasoningContent>{TEXT}</ReasoningContent>
        </Reasoning>
    );
};

describe("reasoning footer", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("copies the reasoning text", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        render(<Harness />);

        fireEvent.click(screen.getByRole("button", { name: "Copy reasoning" }));

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEXT));
    });

    it("collapses from below the text and returns focus to the trigger", () => {
        render(<Harness />);

        fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

        expect(screen.queryByRole("button", { name: "Copy reasoning" })).toBeNull();
        expect(screen.getByRole("button", { name: "Expand thinking" }).matches(":focus")).toBe(true);
    });

    it("offers neither control while the reasoning is still streaming", () => {
        render(<Harness isStreaming />);

        expect(screen.queryByRole("button", { name: "Copy reasoning" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
    });
});
