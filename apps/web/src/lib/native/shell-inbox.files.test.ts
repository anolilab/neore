/** A dock drop carries the account read when the shell starts handing it over, not the one current when it arrives. */
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
    it("tags the files with the account of when their hand-over started", async () => {
        let account: string | undefined = "u1";
        const handler = vi.fn();
        const stop = onNativeFiles(handler, () => account);
        const file = new File(["a"], "a.txt");

        // The pull on subscribe answers nothing; then the shell notifies a drop and is asked for it under u1.
        shell.answer?.([]);
        shell.notify?.();
        account = "u2";
        shell.answer?.([file]);

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith([file], "u1");
        });

        stop();
    });
});
