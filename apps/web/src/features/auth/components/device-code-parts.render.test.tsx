/** The approval page's code field and details, as a screen reader meets them. */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeviceCodeDetails, DeviceCodeField, DeviceCodeForm } from "./device-code-parts";

const HINT = /shows in your terminal/u;
const INSTRUCTION = /matches the one in your terminal/u;

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

describe("DeviceCodeField", () => {
    it("is a labelled, required field described by what to type and where the code comes from", () => {
        render(<DeviceCodeField onChange={vi.fn()} value="" />);

        const field = screen.getByLabelText<HTMLInputElement>("Code");
        const hint = screen.getByText(HINT);

        expect(field.required).toBe(true);
        expect(field.getAttribute("aria-describedby")).toBe(hint.id);
        expect(hint.textContent).toContain("Continue");
    });
});

describe("DeviceCodeDetails", () => {
    it("puts the code in a named list, described by the instruction to compare it with the terminal", () => {
        render(<DeviceCodeDetails code="ABCD-EFGH" hostname="devbox" />);

        const list = screen.getByLabelText("Sign-in request");

        expect(list.textContent).toContain("ABCD-EFGH");
        expect(list.textContent).toContain("devbox");

        const instruction = screen.getByText(INSTRUCTION);

        expect(list.getAttribute("aria-describedby")).toBe(instruction.id);
    });
});

describe("DeviceCodeForm", () => {
    it("says what is wrong, with an alert, and goes nowhere when the code has no letters or digits", () => {
        const onCode = vi.fn();

        render(<DeviceCodeForm onCode={onCode} />);
        fireEvent.change(screen.getByLabelText("Code"), { target: { value: " -- " } });
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));

        expect(screen.getByRole("alert").textContent).toContain("letters and digits");
        expect(onCode).not.toHaveBeenCalled();
    });

    it("passes the normalised code on and clears the alert once the person types again", () => {
        const onCode = vi.fn();

        render(<DeviceCodeForm onCode={onCode} />);
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByRole("alert")).toBeTruthy();

        fireEvent.change(screen.getByLabelText("Code"), { target: { value: "abcd-efgh" } });
        expect(screen.queryByRole("alert")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        expect(onCode).toHaveBeenCalledWith("ABCDEFGH");
    });
});
