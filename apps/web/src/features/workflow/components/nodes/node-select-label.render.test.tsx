/**
 * A node's closed select names the choice by its label, not by the stored value ("Input (Rich Text)", not "input").
 */

// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OutputNodeData, TextNodeData } from "../../types";
import OutputNode from "./output-node";
import TextNode from "./text-node";

// Unit tests do not compile the Lingui macros: a message descriptor carries its own text here.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { message: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { message: string }) => descriptor.message },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("../../stores/workflow-store", () => {
    const state = { execution: { nodeStates: {} }, updateNode: vi.fn() };

    return { useWorkflowStore: (select: (value: typeof state) => unknown) => select(state) };
});

vi.mock("./base-node", () => {
    return { default: ({ children }: { children: ReactNode }) => <div>{children}</div> };
});

vi.mock("@ui/components/tiptap-editor", () => {
    return { TiptapEditorMinimal: () => null };
});

vi.mock("../mention-prompt-field", () => {
    return { default: () => null };
});

afterEach(cleanup);

describe("a node's mode select", () => {
    it("shows the label of the text node's mode, not the stored value", () => {
        const data: TextNodeData = { content: "", label: "Text", mode: "input" };

        render(<TextNode {...({ data, id: "node-1" } as unknown as Parameters<typeof TextNode>[0])} />);

        const trigger = screen.getAllByRole("combobox")[0];

        expect(trigger?.textContent).toContain("Input (Rich Text)");
        expect(trigger?.textContent).not.toBe("input");
    });

    it("shows the label of the output node's type, not the stored value", () => {
        const data: OutputNodeData = { label: "Output", outputType: "markdown" };

        render(<OutputNode {...({ data, id: "node-1" } as unknown as Parameters<typeof OutputNode>[0])} />);

        const trigger = screen.getByRole("combobox");

        expect(trigger.textContent).toContain("Markdown");
        expect(trigger.textContent).not.toContain("markdown");
    });
});
