import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return { calls: 0, importPending: false, preview: vi.fn() };
});

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

// Each render asks for the preview mutation first, then the import one.
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            state.calls += 1;

            return state.calls % 2 === 1 ? { isPending: false, mutateAsync: state.preview } : { isPending: state.importPending, mutateAsync: vi.fn() };
        },
    };
});

// The real dialog needs browser APIs jsdom lacks; its body is what is under test.
vi.mock("@neore/ui/components/responsive-dialog", () => {
    const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

    return { Dialog: Box, DialogContent: Box, DialogDescription: Box, DialogFooter: Box, DialogHeader: Box, DialogPanel: Box, DialogTitle: Box };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {};
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: { skills: { bundle: { importBundle: {}, previewBundle: {} } } } };
});

const { default: BundleImportDialog } = await import("./bundle-import-dialog");

const file = () => new File(["---\nbundle: 1\nname: x\n---\n"], "team.bundle.md", { type: "text/markdown" });

describe("BundleImportDialog while importing", () => {
    beforeEach(() => {
        state.calls = 0;
        state.importPending = false;
        state.preview.mockReset();
    });

    it("lets the person choose a file when nothing is running", () => {
        render(<BundleImportDialog onClose={vi.fn()} onImported={vi.fn()} open />);

        expect((screen.getByRole("button", { name: "Choose bundle file" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("disables the file button and ignores a chosen file while an import runs", async () => {
        state.importPending = true;
        render(<BundleImportDialog onClose={vi.fn()} onImported={vi.fn()} open />);

        expect((screen.getByRole("button", { name: "Choose bundle file" }) as HTMLButtonElement).disabled).toBe(true);

        // The input is hidden from the accessibility tree (a button opens it), so Testing Library has no query for it.
        // eslint-disable-next-line testing-library/no-node-access
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;

        fireEvent.change(input, { target: { files: [file()] } });
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });

        await waitFor(() => expect(state.preview).not.toHaveBeenCalled());
    });
});
