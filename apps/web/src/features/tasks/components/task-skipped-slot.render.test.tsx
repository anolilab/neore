/**
 * A recurrence slot the scheduler skipped because the previous run was still going is shown, with its reason.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TaskSkippedSlot from "./task-skipped-slot";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { i18n: { date: (date: Date) => date.toISOString() }, t: text };
        },
    };
});

describe("TaskSkippedSlot", () => {
    it("shows an overlapping slot as skipped while still running", () => {
        const at = Date.UTC(2026, 10, 6, 9);

        render(
            <dl>
                <TaskSkippedSlot at={at} reason="still_running" />
            </dl>,
        );

        expect(screen.getByText("skipped: still running", { exact: false })).toBeTruthy();
        expect(screen.getByText(new Date(at).toISOString())).toBeTruthy();
    });
});
