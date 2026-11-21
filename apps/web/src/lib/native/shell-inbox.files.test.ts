/** A dock drop carries the account it was handed over under; one that arrives across an account switch goes to neither. */
import { describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => {
    return {
        answer: undefined as ((files: File[]) => void) | undefined,
        notify: undefined as (() => void) | undefined,
    };
});

vi.mock("./bridge", () => {
    return {
        getNative: () => {
            return {
                onFiles: (listener: () => void) => {
                    shell.notify = listener;

                    return () => {};
                },
                takePendingFiles: async () =>
                    await new Promise<File[]>((resolve) => {
                        shell.answer = resolve;
                    }),
            };
        },
        hasNativeCapability: () => true,
    };
});

const { onNativeFiles } = await import("./shell-inbox");

describe(onNativeFiles, () => {
    it("tags the files with the account they were handed over under", async () => {
        const handler = vi.fn();
        const stop = onNativeFiles(handler, () => "u1");
        const file = new File(["a"], "a.txt");

        // The pull on subscribe answers nothing; then the shell notifies a drop and is asked for it under u1.
        shell.answer?.([]);
        shell.notify?.();
        shell.answer?.([file]);

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith([file], "u1");
        });

        stop();
    });

    it("attaches a batch that arrived across an account switch to neither account", async () => {
        let account: string | undefined = "u1";
        const handler = vi.fn();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const stop = onNativeFiles(handler, () => account);

        shell.answer?.([]);
        shell.notify?.();
        account = "u2";
        shell.answer?.([new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(handler).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
        stop();
    });

    it("hands over a drop made while the session loaded, even when it resolves meanwhile", async () => {
        let account: string | undefined;
        const handler = vi.fn();
        const stop = onNativeFiles(handler, () => account);
        const file = new File(["a"], "a.txt");

        shell.answer?.([]);
        shell.notify?.();
        account = "u1";
        shell.answer?.([file]);

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith([file], undefined);
        });

        stop();
    });
});
