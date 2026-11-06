/**
 * The tool rows of a live host turn: a long title wraps rather than cuts, and the tail of a call's output opens at its
 * newest lines and keeps the reader's place once they scroll up.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostToolRow } from "./host-activity";
import { HostToolCalls } from "./host-activity";

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

// jsdom lays nothing out, so the box's size is fixed here; its scroll position is kept as it is set.
const geometry = { clientHeight: 100, scrollHeight: 400 };

const CARGO_TITLE = /^cargo test/u;

const running = (output: string, title = "Run tests"): HostToolRow => {
    return { id: "c1", output, status: "in_progress", title, toolKind: "execute" };
};

const outputBox = (): HTMLElement => screen.getByRole("region", { name: "Output of Run tests" });

beforeEach(() => {
    geometry.clientHeight = 100;
    geometry.scrollHeight = 400;

    Object.defineProperties(HTMLElement.prototype, {
        clientHeight: { configurable: true, get: () => geometry.clientHeight },
        scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    });
});

describe("a coding agent's tool calls", () => {
    it("lets a long title wrap instead of cutting it off", () => {
        render(<HostToolCalls tools={[running("", "cargo test -p neore-device-core --features keychain -- acp_terminal::tests::runs_an_allowed")]} />);

        const title = screen.getByText(CARGO_TITLE);

        expect(title.className).not.toContain("truncate");
        expect(title.className).toContain("break-all");
    });

    it("opens a growing output at its newest lines", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);

        expect(outputBox().scrollTop).toBe(400);

        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(outputBox().scrollTop).toBe(500);
    });

    it("keeps the place of a reader who scrolled up, while the output keeps growing", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);
        const box = outputBox();

        box.scrollTop = 0;
        fireEvent.scroll(box);
        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(box.scrollTop).toBe(0);
    });

    it("moves the reader's focus to the tool row when its output is cleared while they are in it", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);

        outputBox().focus();
        rerender(<HostToolCalls tools={[running("")]} />);

        // eslint-disable-next-line testing-library/no-node-access -- focus placement (document.activeElement) is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("listitem"));
    });

    it("follows the newest lines again once the reader is back at the bottom", () => {
        const { rerender } = render(<HostToolCalls tools={[running("line 1")]} />);
        const box = outputBox();

        box.scrollTop = 0;
        fireEvent.scroll(box);
        box.scrollTop = 400;
        fireEvent.scroll(box);
        geometry.scrollHeight = 500;
        rerender(<HostToolCalls tools={[running("line 1\nline 2")]} />);

        expect(box.scrollTop).toBe(500);
    });
});
