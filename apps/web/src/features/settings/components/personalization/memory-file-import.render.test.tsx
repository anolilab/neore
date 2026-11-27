/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what this test asserts */

/**
 * `<MemoryFileImport>`: a small file answers with its counts, a large one shows the live progress of its job and then the
 * final counts, a refusal shows the server's words, an oversized file never reaches the server, and a job found
 * running can be cancelled. A finished job from an earlier visit is not shown.
 */
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
        /** Holds the progress query's answer back until it is resolved. */
        gate: undefined as Promise<void> | undefined,
        importFile: vi.fn(),
        notify: vi.fn(),
        progress: null as unknown,
        progressError: undefined as Error | undefined,
        progressKey: ["memory-import-progress"] as const,
    };
});

vi.mock("@/lib/native/bridge", () => {
    return { notifyNative: harness.notify };
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
                                return {
                                    queryFn: async () => {
                                        await harness.gate;

                                        if (harness.progressError) {
                                            throw harness.progressError;
                                        }

                                        return harness.progress;
                                    },
                                    queryKey: harness.progressKey,
                                };
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
/** The page's wait for a started job to show up in the progress query. */
const JOB_WAIT_MS = 10_000;
const IMPORTED_60_RE = /Imported 60 /u;
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

/** Picks the file and clicks Import once the page offers it: it does so only after the progress query has answered. */
const startImportOf = async (file: File) => {
    pick(file);

    await waitFor(() => {
        if (screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")) {
            throw new Error("The import is not offered yet");
        }
    });
    fireEvent.click(screen.getByRole("button", { name: "Import file" }));
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
    harness.progressError = undefined;
    harness.gate = undefined;
});

afterEach(() => {
    onlineManager.setOnline(true);
    vi.restoreAllMocks();
    harness.cancel.mockReset();
    harness.importFile.mockReset();
    harness.notify.mockReset();
    onImported.mockReset();
});

describe("memory file import", () => {
    it("shows the counts of a small file and sends its text with the format of its name", async () => {
        expect.assertions(3);

        harness.importFile.mockResolvedValue({ duplicates: 2, imported: 3, invalid: 4, tooLong: 0, updated: 1 });
        renderImport();

        await startImportOf(makeFile("memories.txt", "The user likes tea"));

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

        await startImportOf(makeFile("export.json", "[]"));

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

        await startImportOf(makeFile("secrets.txt", "x"));

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

        await startImportOf(makeFile("export.json", "[]"));

        await screen.findByRole("button", { name: "Cancel import" });

        // The live push trails the start's answer: until it lands the page waits, and does not call that an error.
        expect(screen.queryByRole("alert")).toBeNull();

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
        expect(harness.notify).not.toHaveBeenCalled();
    });

    it("shows a failed progress query with a retry, and keeps Cancel for the job it started", async () => {
        expect.hasAssertions();

        harness.importFile.mockImplementation(async () => {
            harness.progressError = new Error("Network down");

            return { jobId: "job-1", queued: true, total: 100 };
        });
        renderImport();

        await waitFor(() => expect(harness.client?.getQueryData(harness.progressKey)).toBeNull());

        await startImportOf(makeFile("export.json", "[]"));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Network down");
        expect(screen.queryByText("Importing memories…")).toBeNull();
        expect(screen.getByRole("button", { name: "Cancel import" })).toBeTruthy();

        harness.progressError = undefined;
        harness.progress = job({ done: 10, status: "running" });
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("10 of 100 entries processed")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows the error when the progress query fails on load, and does not offer an import until it answers", async () => {
        expect.hasAssertions();

        harness.progressError = new Error("Network down");
        renderImport();

        const failure = await screen.findByRole("alert");

        expect(failure.textContent).toBe("Network down");

        pick(makeFile("export.json", "[]"));

        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);

        harness.progressError = undefined;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false);
        expect(screen.queryByText("Importing memories…")).toBeNull();
    });

    it("tells the shell when an import this page started ends, and when one it found running stops", async () => {
        expect.hasAssertions();

        harness.importFile.mockImplementation(async () => {
            harness.progress = job({ done: 10, status: "queued" });

            return { jobId: "job-1", queued: true, total: 100 };
        });

        const view = renderImport();

        await startImportOf(makeFile("export.json", "[]"));
        await screen.findByText("10 of 100 entries processed");

        expect(harness.notify).not.toHaveBeenCalled();

        publish(job({ done: 100, imported: 60, status: "done" }));
        await screen.findByText("Import finished.");

        expect(harness.notify).toHaveBeenCalledOnce();

        view.unmount();
        harness.notify.mockReset();
        harness.progress = job({ done: 25, jobId: "job-2", status: "running" });
        harness.client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        renderImport();
        await screen.findByRole("button", { name: "Cancel import" });

        publish(job({ done: 30, error: "The import was cancelled.", jobId: "job-2", status: "failed" }));
        await screen.findByRole("alert");

        expect(harness.notify).toHaveBeenCalledOnce();
        expect(harness.notify.mock.calls[0]?.[0]).toStrictEqual({ title: "Memory import stopped" });
    });

    it("refreshes again when the final counts are written after the job's status already ended", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 25, status: "running" });
        renderImport();
        await screen.findByRole("button", { name: "Cancel import" });

        publish(job({ done: 90, imported: 50, status: "done" }));
        await screen.findByText("Import finished.");

        expect(onImported).toHaveBeenCalledTimes(1);

        publish(job({ done: 100, imported: 60, status: "done" }));

        await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));

        expect(screen.getByRole("status").textContent).toMatch(IMPORTED_60_RE);
    });

    it("does not offer an import before the progress query has answered", async () => {
        expect.hasAssertions();

        let open: () => void = () => undefined;

        // The project's TypeScript lib has no `Promise.withResolvers` yet.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        harness.gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        renderImport();

        pick(makeFile("export.json", "[]"));

        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);

        open();

        await waitFor(() => expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false));
    });

    it("fails an import at once while offline instead of running it when the connection returns", async () => {
        expect.hasAssertions();

        harness.importFile.mockRejectedValue(new Error("You are offline."));
        renderImport();

        pick(makeFile("memories.txt", "The user likes tea"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false));

        onlineManager.setOnline(false);
        fireEvent.click(screen.getByRole("button", { name: "Import file" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("You are offline.");
        expect(harness.importFile).toHaveBeenCalledOnce();
    });

    it("clears a finished background import's outcome when a new file is picked", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 25, status: "running" });
        renderImport();
        await screen.findByRole("button", { name: "Cancel import" });

        publish(job({ done: 100, duplicates: 20, imported: 60, invalid: 14, status: "done", tooLong: 1, updated: 5 }));
        await screen.findByText("Import finished.");

        pick(makeFile("next.txt", "The user likes coffee"));

        expect(screen.queryByText("Import finished.")).toBeNull();
        expect(screen.getByRole("status").textContent).not.toMatch(FINAL_RE);
    });

    it("keeps a running background import on screen when a new file is picked", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 25, status: "running" });
        renderImport();
        await screen.findByRole("button", { name: "Cancel import" });

        pick(makeFile("next.txt", "The user likes coffee"));

        expect(screen.getByRole("button", { name: "Cancel import" })).toBeTruthy();
        expect(screen.getByText("25 of 100 entries processed")).toBeTruthy();
    });

    it("does not offer an import on a cached answer until a fetch after memory came back has settled", async () => {
        expect.hasAssertions();

        harness.importFile.mockResolvedValue({ duplicates: 0, imported: 1, invalid: 0, tooLong: 0, updated: 0 });

        const view = renderImport();

        pick(makeFile("export.json", "[]"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false));

        view.rerender(importUi(false));

        // Another tab starts an import while memory is off; the next answer is held back.
        let open: () => void = () => undefined;

        harness.progress = job({ done: 40, jobId: "job-2", status: "running" });
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        harness.gate = new Promise<void>((resolve) => {
            open = resolve;
        });
        view.rerender(importUi(true));

        expect(harness.client?.getQueryData(harness.progressKey)).toBeNull();
        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);

        open();

        expect(await screen.findByRole("button", { name: "Cancel import" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);
        expect(harness.importFile).not.toHaveBeenCalled();
    });

    it("shows the failure and a retry when the refresh after memory came back fails, then offers an import once it answers", async () => {
        expect.hasAssertions();

        const view = renderImport();

        pick(makeFile("export.json", "[]"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false));

        view.rerender(importUi(false));

        harness.progressError = new Error("Network down");
        view.rerender(importUi(true));

        const failure = await screen.findByRole("alert");

        expect(failure.textContent).toBe("Network down");
        expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(true);

        harness.progressError = undefined;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        await waitFor(() => expect(screen.getByRole("button", { name: "Import file" }).hasAttribute("disabled")).toBe(false));

        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("follows a job another tab created while its own start was being answered", async () => {
        expect.hasAssertions();

        harness.progress = job({ done: 100, jobId: "job-0", status: "done" });
        harness.importFile.mockImplementation(async () => {
            publish(job({ done: 40, jobId: "job-2", status: "running" }));
            // Lets the page render the other tab's job before this start is answered.
            await act(async () => {
                await Promise.resolve();
            });

            return { jobId: "job-1", queued: true, total: 100 };
        });
        renderImport();

        await waitFor(() => expect(harness.client?.getQueryData(harness.progressKey)).toBeTruthy());

        await startImportOf(makeFile("export.json", "[]"));

        expect(await screen.findByText("40 of 100 entries processed")).toBeTruthy();
    });

    it("ends the wait with an error when the progress query never shows the job the start returned", async () => {
        expect.hasAssertions();

        // Only the page's own wait is held back; the polling of `waitFor` keeps its real timers.
        const realSetTimeout = globalThis.setTimeout;
        let giveUp: (() => void) | undefined;

        vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number, ...rest: unknown[]) => {
            if (delay === JOB_WAIT_MS) {
                giveUp = handler;

                return 0 as unknown as ReturnType<typeof setTimeout>;
            }

            return realSetTimeout(handler, delay, ...rest);
        }) as typeof setTimeout);

        harness.progress = job({ done: 100, jobId: "job-0", status: "done" });
        harness.importFile.mockResolvedValue({ jobId: "job-1", queued: true, total: 100 });
        renderImport();

        await waitFor(() => expect(harness.client?.getQueryData(harness.progressKey)).toBeTruthy());

        await startImportOf(makeFile("export.json", "[]"));

        await screen.findByRole("button", { name: "Cancel import" });

        expect(screen.queryByRole("alert")).toBeNull();

        act(() => {
            giveUp?.();
        });

        const unconfirmed = screen.getByRole("alert");

        expect(unconfirmed.textContent).toBe("Could not read the import's progress.");
        expect(screen.queryByText("Importing memories…")).toBeNull();
        expect(screen.getByRole("button", { name: "Cancel import" })).toBeTruthy();

        harness.progress = job({ done: 10, jobId: "job-1", status: "running" });
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("10 of 100 entries processed")).toBeTruthy();
    });
});
