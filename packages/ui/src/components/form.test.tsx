// @vitest-environment jsdom

/**
 * A form control takes its field's id and ARIA state itself, so the label names it, and it keeps its own slot and
 * children. Several children keep the wrapper.
 */
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppForm } from "./form";
import { Input } from "./input";

const dom = {} as { container: HTMLDivElement; root: Root };

beforeEach(() => {
    dom.container = document.createElement("div");
    document.body.append(dom.container);
    dom.root = createRoot(dom.container);
});

afterEach(() => {
    act(() => {
        dom.root.unmount();
    });
    dom.container.remove();
});

const Field = ({ control }: { control: (handlers: { onChange: (value: string) => void; value: string }) => ReactNode }) => {
    const form = useAppForm({ defaultValues: { name: "" } });

    return (
        <form.AppField name="name">
            {(field) => (
                <field.FormItem required>
                    <field.FormLabel>Name</field.FormLabel>
                    <field.FormControl>{control({ onChange: field.handleChange, value: field.state.value })}</field.FormControl>
                </field.FormItem>
            )}
        </form.AppField>
    );
};

const renderField = (control: Parameters<typeof Field>[0]["control"]) => {
    act(() => {
        dom.root.render(<Field control={control} />);
    });
};

describe("FormControl", () => {
    it("puts the id and ARIA state on a single input, so its label names it, and keeps the input's own slot", () => {
        renderField(({ onChange, value }) => <Input onChange={(event) => onChange(event.target.value)} value={value} />);

        const input = dom.container.querySelector("input");
        const label = dom.container.querySelector("label");

        expect(input?.id).toBeTruthy();
        expect(label?.htmlFor).toBe(input?.id);
        expect(input?.getAttribute("aria-required")).toBe("true");
        expect(input?.dataset.slot).toBe("input");
        expect(dom.container.querySelector("[data-slot=form-control]")).toBeNull();
    });

    it("keeps a control's own children", () => {
        renderField(() => (
            <button data-slot="select-trigger" type="button">
                <span>Can comment</span>
            </button>
        ));

        const button = dom.container.querySelector("button");

        expect(button?.textContent).toBe("Can comment");
        expect(button?.dataset.slot).toBe("select-trigger");
        expect(dom.container.querySelector("label")?.htmlFor).toBe(button?.id);
    });

    it("keeps the wrapper for several children", () => {
        renderField(() => (
            <>
                <span>/</span>
                <input />
            </>
        ));

        const wrapper = dom.container.querySelector("[data-slot=form-control]");

        expect(wrapper?.tagName).toBe("DIV");
        expect(wrapper?.textContent).toBe("/");
    });
});
