/**
 * A dated memory shows its days in the list: the day or days an event happens,
 * and the last day a fact holds. A stored day is a calendar day, so the
 * viewer's timezone never shifts it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { MemoryItemData } from "./memory-item";
import MemoryItem from "./memory-item";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { date: (value: Date, format: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", format).format(value) },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    };
});

const renderItem = (dates: Partial<MemoryItemData>, onSave = vi.fn()): void => {
    const memory: MemoryItemData = { _id: "m1", createdAt: 0, lastConfirmedAt: 0, memory: "User is travelling", pinned: false, type: "context", ...dates };

    render(<MemoryItem busy={false} memory={memory} onDelete={vi.fn()} onSave={onSave} onTogglePin={vi.fn()} relativeTime={() => "1d ago"} />);
};

describe("memory item dates", () => {
    it("shows an event's range and the day a fact ends", () => {
        renderItem({ eventEnd: "2026-11-22", eventStart: "2026-11-20", validUntil: "2026-11-22" });

        expect(screen.getByText("Nov 20, 2026 – Nov 22, 2026").textContent).toBeTruthy();
        expect(screen.getByText("Until Nov 22, 2026").textContent).toBeTruthy();
    });

    it("shows a single event day", () => {
        renderItem({ eventStart: "2026-11-01" });

        expect(screen.getByText("On Nov 1, 2026").textContent).toBeTruthy();
    });
});

describe("editing a memory's dates", () => {
    it("clears a wrong end date and saves all three dates as the person left them", () => {
        const saved = vi.fn();

        renderItem({ eventStart: "2026-11-20", validUntil: "2026-11-22" }, saved);

        fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
        fireEvent.change(screen.getByLabelText("Holds until"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(saved).toHaveBeenCalledWith("m1", { dates: { eventEnd: "", eventStart: "2026-11-20", validUntil: "" } });
    });

    it("refuses an event that ends before it starts", () => {
        const saved = vi.fn();

        renderItem({ eventStart: "2026-11-20" }, saved);

        fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
        fireEvent.change(screen.getByLabelText("Event ends on"), { target: { value: "2026-11-19" } });

        expect(screen.getByRole("alert").textContent).toBe("An event cannot end before it starts.");
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
        expect(saved).not.toHaveBeenCalled();
    });
});
