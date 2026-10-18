/**
 * A node's model picker: its trigger is named by the visible label, so a screen reader says what it chooses.
 */

import { render, screen } from "@testing-library/react";
import { Label } from "@ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { describe, expect, it, vi } from "vitest";

import ModelSelect from "./model-select";

// Unit tests do not compile the Lingui macros; the Pro marker calls `Trans`.
vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
    };
});

describe("ModelSelect", () => {
    it("names its trigger with the visible label", () => {
        render(
            <ModelSelect
                label="Model"
                onChange={vi.fn()}
                options={[
                    { label: "Fast", value: "fast" },
                    { isPremium: true, label: "Best", value: "best" },
                ]}
                placeholder="Select model..."
                value="fast"
            />,
        );

        expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
    });
});

describe("labelled selects in a node", () => {
    it("names a trigger by a label that points at its id, as the video resolution picker does", () => {
        render(
            <>
                <Label htmlFor="resolution">Resolution</Label>
                <Select value="720p">
                    <SelectTrigger id="resolution">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="720p">720p</SelectItem>
                    </SelectContent>
                </Select>
            </>,
        );

        expect(screen.getByRole("combobox", { name: "Resolution" })).toBeTruthy();
    });
});
