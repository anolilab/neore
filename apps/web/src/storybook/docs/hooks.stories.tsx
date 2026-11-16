import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import useDebouncedCallback from "@neore/ui/hooks/use-debounced-callback";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor } from "storybook/test";

/** Searches 300 ms after the last keystroke, not on every one. */
const DebouncedSearch = () => {
    const [query, setQuery] = useState("");
    const [searched, setSearched] = useState("");
    const search = useDebouncedCallback((value: string) => {
        setSearched(value);
    }, 300);

    return (
        <div className="grid max-w-sm gap-2">
            <Label htmlFor="debounced-search">Search</Label>
            <Input
                id="debounced-search"
                onChange={(event) => {
                    setQuery(event.target.value);
                    search(event.target.value);
                }}
                value={query}
            />
            <p className="text-muted-foreground text-sm" role="status">
                {searched === "" ? "Nothing searched yet" : `Searched for “${searched}”`}
            </p>
        </div>
    );
};

const meta = {
    component: DebouncedSearch,
    parameters: { layout: "padded" },
    title: "Hooks/useDebouncedCallback",
} satisfies Meta<typeof DebouncedSearch>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await userEvent.type(canvas.getByLabelText("Search"), "neore");
        await waitFor(() => {
            expect(canvas.getByRole("status")).toHaveTextContent("Searched for “neore”");
        });
    },
};
