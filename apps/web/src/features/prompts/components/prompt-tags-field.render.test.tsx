// @vitest-environment jsdom

/** The tags field of the prompt form: every control has a name, and typing, pasting and removing keep the tag list in step. */
import { useAppForm } from "@neore/ui/components/form";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PromptTag } from "./prompt-tags-field";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

// The suggestions popup scrolls inside a ScrollArea, which constructs a ResizeObserver and asks elements for their
// animations; jsdom has neither, and the shared setup's ResizeObserver stub is an arrow function that cannot be constructed.
// The setup reassigns it before every test, so replace it in a hook that runs after it.
beforeEach(() => {
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [], writable: true });
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

const { default: PromptTagsField } = await import("./prompt-tags-field");

const texts = (tags: PromptTag[]) => tags.map((tag) => tag.text);

const Harness = ({ initial, onSubmit, options }: { initial: PromptTag[]; onSubmit: () => void; options: string[] }) => {
    const [seen, setSeen] = useState<PromptTag[]>(initial);
    const form = useAppForm({ defaultValues: { tags: initial } });

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
            }}
        >
            <form.AppForm>
                <form.AppField name="tags">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel>Tags</field.FormLabel>
                            <PromptTagsField
                                onChange={(next) => {
                                    field.handleChange(next);
                                    setSeen(next);
                                }}
                                options={options}
                                value={field.state.value}
                            />
                        </field.FormItem>
                    )}
                </form.AppField>
            </form.AppForm>
            <output data-testid="tags">{JSON.stringify(seen)}</output>
        </form>
    );
};

const current = () => JSON.parse(screen.getByTestId("tags").textContent ?? "[]") as PromptTag[];

describe("PromptTagsField", () => {
    it("names the input after the label and every remove button after its tag", () => {
        render(<Harness initial={[{ id: "a", text: "alpha" }]} onSubmit={() => {}} options={["alpha", "beta"]} />);

        expect(screen.getByRole("combobox", { name: "Tags" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
        expect(screen.queryAllByRole("button").every((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").length > 0)).toBe(true);
    });

    it("adds the typed text on Enter without submitting the form", async () => {
        const onSubmit = vi.fn();
        const user = userEvent.setup();

        render(<Harness initial={[]} onSubmit={onSubmit} options={["alpha"]} />);
        await user.type(screen.getByRole("combobox", { name: "Tags" }), "  gamma {Enter}");

        expect(texts(current())).toEqual(["gamma"]);
        expect(onSubmit).not.toHaveBeenCalled();
        expect((screen.getByRole("combobox", { name: "Tags" }) as HTMLInputElement).value).toBe("");
    });

    it("splits pasted text on commas and skips duplicates", async () => {
        const user = userEvent.setup();

        render(<Harness initial={[{ id: "alpha", text: "alpha" }]} onSubmit={() => {}} options={[]} />);
        await user.click(screen.getByRole("combobox", { name: "Tags" }));
        await user.paste("alpha, beta,gamma");

        expect(texts(current())).toEqual(["alpha", "beta", "gamma"]);
    });

    it("removes a tag from its remove button", async () => {
        const user = userEvent.setup();

        render(
            <Harness
                initial={[
                    { id: "a", text: "alpha" },
                    { id: "b", text: "beta" },
                ]}
                onSubmit={() => {}}
                options={[]}
            />,
        );
        const first = screen.getAllByRole("button", { name: "Remove" }).at(0);

        expect(first).toBeDefined();

        if (first) {
            await user.click(first);
        }

        expect(texts(current())).toEqual(["beta"]);
    });

    it("offers existing tags and adds the one picked", async () => {
        const user = userEvent.setup();

        render(<Harness initial={[]} onSubmit={() => {}} options={["alpha", "beta"]} />);
        await user.click(screen.getByRole("combobox", { name: "Tags" }));
        await user.click(await screen.findByRole("option", { name: "beta" }));

        expect(texts(current())).toEqual(["beta"]);
    });

    it("marks the suggestions popup empty when the typed text matches nothing, so it can be hidden", async () => {
        const user = userEvent.setup();

        render(<Harness initial={[]} onSubmit={() => {}} options={["alpha", "beta"]} />);
        await user.type(screen.getByRole("combobox", { name: "Tags" }), "zzz");

        expect(screen.getByRole("listbox", { hidden: true }).dataset.empty).toBeDefined();
    });
});
