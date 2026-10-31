import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TriggerTypePicker, { SELECTABLE_TRIGGER_TYPES } from "./trigger-type-picker";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

describe("TriggerTypePicker", () => {
    it("offers schedule, webhook and event", () => {
        render(<TriggerTypePicker onSelect={vi.fn()} value="schedule" />);

        expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Schedule", "Webhook", "Event"]);
        expect(SELECTABLE_TRIGGER_TYPES).toContain("event");
    });

    it("reports the chosen type", () => {
        const onSelect = vi.fn();

        render(<TriggerTypePicker onSelect={onSelect} value="schedule" />);
        fireEvent.click(screen.getByRole("button", { name: "Webhook" }));

        expect(onSelect).toHaveBeenCalledWith("webhook");
    });

    it("locks the choice when disabled", () => {
        const onSelect = vi.fn();

        render(<TriggerTypePicker disabled onSelect={onSelect} value="event" />);

        for (const button of screen.getAllByRole("button")) {
            expect((button as HTMLButtonElement).disabled).toBe(true);
        }

        fireEvent.click(screen.getByRole("button", { name: "Webhook" }));

        expect(onSelect).not.toHaveBeenCalled();
    });
});
