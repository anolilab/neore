/**
 * `<MemoryImportDialog>`: with memory off it only offers to turn memory on; with it on, a
 * preview lists the facts and the save sends only the ones left checked, with the chosen app.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MemoryImportDialog from "./memory-import-dialog";

const calls = vi.hoisted(() => {
    return { preview: vi.fn(), save: vi.fn() };
});

vi.mock("@lingui/core/macro", () => {
    return {
        plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other).replace("#", () => String(count)),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: (ref: unknown) => {
            return { mutationFn: JSON.stringify(ref).includes("preview") ? calls.preview : calls.save };
        },
    };
});

const LIKES_TEA_RE = /likes tea/;
const TOO_LONG_RE = /longer than 20000 characters/;

const openDialog = (memoryEnabled: boolean, onEnableMemory: () => Promise<void> = async () => undefined) => {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <MemoryImportDialog memoryEnabled={memoryEnabled} onEnableMemory={onEnableMemory} onImported={vi.fn()} />
        </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bring in what another AI knows about you" }));
};

// The dialog's scroll area constructs a ResizeObserver; its close waits on `getAnimations`.
class ResizeObserverStub {
    disconnect() {
        return this;
    }

    observe() {
        return this;
    }

    unobserve() {
        return this;
    }
}

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, "getAnimations");
    calls.preview.mockReset();
    calls.save.mockReset();
});

describe("memory import dialog", () => {
    it("offers to turn memory on and nothing else while it is off", async () => {
        expect.assertions(3);

        const onEnableMemory = vi.fn(async () => undefined);

        openDialog(false, onEnableMemory);

        fireEvent.click(await screen.findByRole("button", { name: "Turn on memory" }));

        expect(onEnableMemory).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
        expect(screen.queryByLabelText("3. Paste its answer")).toBeNull();
    });

    it("saves only the facts left checked, with the chosen app", async () => {
        expect.hasAssertions();

        calls.preview.mockResolvedValue({
            cut: 0,
            dropped: 1,
            facts: [
                { memory: "The user is a nurse", type: "identity" },
                { memory: "The user likes tea", type: "preference" },
            ],
        });
        calls.save.mockResolvedValue({ added: 1, alreadyKnown: 0, updated: 0 });

        openDialog(true);

        fireEvent.click(await screen.findByRole("button", { name: "Gemini" }));
        fireEvent.change(screen.getByLabelText("3. Paste its answer"), { target: { value: "The user is a nurse\nThe user likes tea" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));

        fireEvent.click(await screen.findByRole("checkbox", { name: LIKES_TEA_RE }));

        // The Preview button unmounted: focus lands on the step it opened, not the page.
        expect(document.activeElement?.textContent).toBe("4. Choose what to keep");

        fireEvent.click(screen.getByRole("button", { name: "Save 1 memory" }));

        await waitFor(() => expect(calls.save).toHaveBeenCalledOnce());

        expect(calls.save.mock.calls[0]?.[0]).toStrictEqual({ app: "gemini", facts: [{ memory: "The user is a nurse", type: "identity" }] });
    });

    it("says a paste is too long instead of cutting it, and offers no preview of it", async () => {
        expect.assertions(2);

        openDialog(true);

        fireEvent.change(await screen.findByLabelText("3. Paste its answer"), { target: { value: "x".repeat(20_001) } });

        expect(screen.getByText(TOO_LONG_RE)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
    });

    it("returns focus to the paste field on Back", async () => {
        expect.assertions(1);

        calls.preview.mockResolvedValue({ cut: 0, dropped: 0, facts: [{ memory: "The user is a nurse", type: "identity" }] });

        openDialog(true);

        fireEvent.change(await screen.findByLabelText("3. Paste its answer"), { target: { value: "The user is a nurse" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        fireEvent.click(await screen.findByRole("button", { name: "Back" }));

        await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    });
});
