/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts */

/**
 * `<MemoryFileImport>`: a small file answers with its counts, a large one shows the live progress of its job and then the
 * final counts, a refusal shows the server's words, an oversized file never reaches the server, and a job found
 * running can be cancelled. A finished job from an earlier visit is not shown.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MemoryFileImport from "./memory-file-import";

interface Progress {
    done: number;
    duplicates: number;
    error?: string;
    imported: number;
    invalid: number;
    jobId: string;
    status: "done" | "failed" | "queued" | "running";
    tooLong: number;
    total: number;
    updated: number;
}

const harness = vi.hoisted(() => {
    return {
        cancel: vi.fn(),
        client: undefined as QueryClient | undefined,
        importFile: vi.fn(),
        progress: null as unknown,
        progressKey: ["memory-import-progress"] as const,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { number: (value: number) => value.toLocaleString("en-US") },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                memory: {
                    import_job: {
                        cancelMemoryImport: {
                            mutationOptions: () => {
                                return { mutationFn: harness.cancel };
                            },
                        },
                        getMemoryImportProgress: {
                            queryOptions: () => {
                                return { queryFn: async () => harness.progress, queryKey: harness.progressKey };
                            },
                        },
                    },
                },
            };
        },
        useLunoraActionOptions: () => {
            return { mutationFn: harness.importFile };
        },
    };
});

const job = (overrides: Partial<Progress>): Progress => {
    return { done: 0, duplicates: 0, imported: 0, invalid: 0, jobId: "job-1", status: "running", tooLong: 0, total: 100, updated: 0, ...overrides };
};

/** A file whose text is read from `content`; `size` stands in for a large file without building it. */
const makeFile = (name: string, content: string, size?: number): File => {
    const file = new File([content], name);

    Object.defineProperty(file, "text", { value: async () => content });

    if (size !== undefined) {
        Object.defineProperty(file, "size", { value: size });
    }

    return file;
};

const COUNTS_RE = /Imported 3 · Updated 1 · Duplicates 2 · Too long 0 · Invalid 4/u;
const FINAL_RE = /Imported 60 · Updated 5 · Duplicates 20 · Too long 1 · Invalid 14/u;
const LARGER_RE = /larger than 500 KB/u;

const onImported = vi.fn();

const importUi = (memoryEnabled: boolean) => (
    <QueryClientProvider client={harness.client ?? new QueryClient()}>
        <MemoryFileImport memoryEnabled={memoryEnabled} onImported={onImported} />
    </QueryClientProvider>
);

const renderImport = (memoryEnabled = true) => render(importUi(memoryEnabled));

const pick = (file: File) => {
    fireEvent.change(screen.getByLabelText("File to import"), { target: { files: [file] } });
};

/** The server's new answer: a refetch reads it as well as the live push. */
const publish = (progress: Progress) => {
    harness.progress = progress;
    act(() => {
        harness.client?.setQueryData(harness.progressKey, progress);
    });
};

beforeEach(() => {
    harness.client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    harness.progress = null;
});

afterEach(() => {
    harness.cancel.mockReset();
    harness.importFile.mockReset();
    onImported.mockReset();
});

describe("memory file import", () => {
    it("shows the counts of a small file and sends its text with the format of its name", async () => {
        expect.assertions(3);

        harness.importFile.mockResolvedValue({ duplicates: 2, imported: 3, invalid: 4, tooLong: 0, updated: 1 });
        renderImport();

        pick(makeFile("memories.txt", "The user likes tea"));
        fireEvent.click(screen.getByRole("button", { name: "Import file" }));

        await screen.findByText("Import finished.");

        expect(screen.getByRole("status").textContent).toMatch(COUNTS_RE);
        expect(harness.importFile.mock.calls[0]?.[0]).toStrictEqual({ content: "The user likes tea", format: "text" });
        expect(onImported).toHaveBeenCalledOnce();
    });

    it("shows the progress of a large file's job, then its final counts", async () => {
        expect.assertions(5);

        harness.importFile.mockImplementation(async () => {
            harness.progress = job({ done: 10, imported: 8, status: "queued" });

            return { jobId: "job-1", queued: true, total: 100 };
        });
        renderImport();

        pick(makeFile("export.json", "[]"));
        fireEvent.click(screen.getByRole("button", { name: "Import file" }));

        await screen.findByText("10 of 100 entries processed");

        publish(job({ done: 40, duplicates: 5, imported: 30, invalid: 5 }));

        expect(await screen.findByText("40 of 100 entries processed")).toBeTruthy();
        expect(screen.getByRole("progressbar", { name: "Import progress" })).toBeTruthy();
        expect(onImported).not.toHaveBeenCalled();

        publish(job({ done: 100, duplicates: 20, imported: 60, invalid: 14, status: "done", tooLong: 1, updated: 5 }));

        expect(await screen.findByText("Import finished.")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toMatch(FINAL_RE);
    });

    it("shows the server's refusal word for word", async () => {
        expect.assertions(2);

        const message = "Line 3 holds a password or key whose value continues on the next line. Remove it and try again.";

        harness.importFile.mockRejectedValue(new Error(message));
        renderImport();

        pick(makeFile("secrets.txt", "x"));
        fireEvent.click(screen.getByRole("button", { name: "Import file" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe(message);
        expect(screen.queryByText("Import finished.")).toBeNull();
    });

    it("refuses a file over the limit without calling the server", () => {
        expect.assertions(3);

        renderImport();

        pick(makeFile("big.txt", "x", 500_001));

        expect(screen.getByRole("alert").textContent).toMatch(LARGER_RE);
        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);
        expect(harness.importFile).not.toHaveBeenCalled();
    });

    it("refuses a file that is neither .txt nor .json", () => {
        expect.assertions(2);

        renderImport();

        pick(makeFile("notes.docx", "x"));

        expect(screen.getByRole("alert").textContent).toBe("Choose a .txt or .json file.");
        expect(harness.importFile).not.toHaveBeenCalled();
    });

    it("is disabled with memory off and says why", () => {
        expect.assertions(3);

        renderImport(false);

        expect(screen.getByLabelText("File to import").hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("Turn on memory to import a file.")).toBeTruthy();
    });

    it("cancels the running job it finds on load, and moves focus to the result when the job ends", async () => {
        expect.assertions(5);

        harness.progress = job({ done: 25, imported: 20, status: "running" });
        harness.cancel.mockResolvedValue(null);
        renderImport();

        const cancel = await screen.findByRole("button", { name: "Cancel import" });

        cancel.focus();
        fireEvent.click(cancel);

        await waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce());

        expect(harness.cancel.mock.calls[0]?.[0]).toStrictEqual({ jobId: "job-1" });

        publish(job({ done: 50, error: "The import was cancelled. Memories already imported are kept.", imported: 40, status: "failed" }));

        const stopped = await screen.findByRole("alert");

        expect(stopped.textContent).toBe("The import was cancelled. Memories already imported are kept.");
        expect(document.activeElement).toBe(screen.getByRole("group", { name: "Import result" }));
    });

    it("shows how a newer job ended when another tab ran it while this page watched an older one", async () => {
        expect.assertions(4);

        harness.progress = job({ done: 25, status: "running" });
        renderImport();

        await screen.findByRole("button", { name: "Cancel import" });

        publish(job({ done: 100, duplicates: 20, imported: 60, invalid: 14, jobId: "job-2", status: "done", tooLong: 1, updated: 5 }));

        expect(await screen.findByText("Import finished.")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toMatch(FINAL_RE);
        expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
        expect(screen.queryByRole("progressbar")).toBeNull();
    });

    it("shows how a newer job ended when this page's own job ended before the query ever showed it", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 100, jobId: "job-0", status: "done" });
        harness.importFile.mockResolvedValue({ jobId: "job-1", queued: true, total: 100 });
        renderImport();

        await waitFor(() => expect(harness.client?.getQueryData(harness.progressKey)).toBeTruthy());

        pick(makeFile("export.json", "[]"));
        fireEvent.click(screen.getByRole("button", { name: "Import file" }));

        await screen.findByRole("button", { name: "Cancel import" });

        publish(job({ done: 100, duplicates: 20, imported: 60, invalid: 14, jobId: "job-2", status: "done", tooLong: 1, updated: 5 }));

        expect(await screen.findByText("Import finished.")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toMatch(FINAL_RE);
        expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
    });

    it("stops showing a running import while memory is off, and shows how it ended once memory is on", async () => {
        expect.assertions(5);

        harness.progress = job({ done: 25, status: "running" });

        const view = renderImport();

        await screen.findByRole("button", { name: "Cancel import" });

        view.rerender(importUi(false));

        expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
        expect(screen.queryByRole("progressbar")).toBeNull();
        expect(screen.getByText("Turn on memory to import a file.")).toBeTruthy();

        const message = "Memory was turned off, so the import stopped.";

        publish(job({ done: 30, error: message, status: "failed" }));
        view.rerender(importUi(true));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe(message);
        expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
    });

    it("shows nothing for a job that ended before this visit", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 100, imported: 60, status: "done" });
        renderImport();

        await waitFor(() => expect(harness.client?.getQueryData(harness.progressKey)).toBeTruthy());

        expect(screen.queryByText("Import finished.")).toBeNull();
        expect(screen.queryByRole("progressbar")).toBeNull();
        expect(onImported).not.toHaveBeenCalled();
    });
});
