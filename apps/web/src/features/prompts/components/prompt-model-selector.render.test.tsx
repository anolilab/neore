// @vitest-environment jsdom

import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import PromptModelSelector from "./prompt-model-selector";

const received = vi.hoisted(() => {
    return { triggerProps: undefined as ComponentProps<"button"> | undefined };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});
vi.mock("@/components/model-picker", () => {
    return {
        ModelPickerButton: ({ triggerProps }: { triggerProps?: ComponentProps<"button"> }) => {
            received.triggerProps = triggerProps;

            return null;
        },
    };
});

describe(PromptModelSelector, () => {
    it("hands a form field's id and state to the picker button, the element its label and messages are about", () => {
        render(<PromptModelSelector aria-describedby="model-description model-message" aria-invalid id="model-field" onChange={() => {}} value={undefined} />);

        expect(received.triggerProps).toStrictEqual({ "aria-describedby": "model-description model-message", "aria-invalid": true, id: "model-field" });
    });
});
