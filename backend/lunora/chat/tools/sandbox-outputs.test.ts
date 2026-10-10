/**
 * Sandbox output files: which files a run hands back, the caps, and the
 * property that matters most — the `storage:` reference in the tool result is
 * signed for the user whose run stored it and for nobody else.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStoredMedia, UNAVAILABLE_TOOL_STORAGE_URL } from "../../agent/stored-media";
import { addFile } from "../../agent/files";
import { sha256Hex } from "../../lib/crypto";
import { ownedStorageKeys } from "../../lib/storage-ownership";
import schema from "../../schema";
import type { OutputSandbox, SandboxEntry } from "./sandbox-outputs";
import {
    collectSandboxOutputs,
    MAX_OUTPUT_FILE_BYTES,
    MAX_OUTPUT_FILES,
    MAX_OUTPUT_TOTAL_BYTES,
    outputFileName,
    planOutputCollection,
    SANDBOX_OUTPUT_DIR,
    SANDBOX_OUTPUT_INSTRUCTIONS,
    snapshotOf,
    snapshotSandboxOutputs,
} from "./sandbox-outputs";

const STORAGE_REF = /^storage:agent-files\/[\da-f]{64}$/u;

const T0 = new Date("2026-09-25T10:00:00Z");
const T1 = new Date("2026-09-25T10:00:05Z");

const file = (name: string, size = 10, modifiedTime = T1, extra: Partial<SandboxEntry> = {}): SandboxEntry => {
    return { modifiedTime, name: name.split("/").pop() ?? name, path: `${SANDBOX_OUTPUT_DIR}/${name}`, size, type: "file", ...extra };
};

/** An in-memory sandbox whose output directory holds `entries`, with `bytes` per path. */
const fakeSandbox = (entries: () => SandboxEntry[], bytes: (path: string) => Uint8Array = () => new Uint8Array([1, 2, 3])) => {
    const read = vi.fn(async (path: string) => bytes(path));
    const sandbox: OutputSandbox = {
        files: {
            list: vi.fn(async () => entries()),
            makeDir: vi.fn(async () => true),
            read,
        },
    };

    return { read, sandbox };
};

describe("planOutputCollection", () => {
    it("collects files that are new or changed since the snapshot, and nothing else", () => {
        const before = snapshotOf([file("old.png", 10, T0), file("edited.csv", 10, T0)]);
        const plan = planOutputCollection(before, [file("old.png", 10, T0), file("edited.csv", 12, T1), file("new.pdf")]);

        expect(plan.collect.map((entry) => entry.name)).toStrictEqual(["edited.csv", "new.pdf"]);
        expect(plan.skipped).toStrictEqual([]);
    });

    it("skips directories, symlinks and types off the allowlist", () => {
        const plan = planOutputCollection(new Map(), [
            file("chart.png"),
            { ...file("sub"), type: "dir" },
            file("passwd.txt", 10, T1, { symlinkTarget: "/etc/passwd" }),
            file("page.html"),
            file("run.sh"),
            file("noextension"),
        ]);

        expect(plan.collect.map((entry) => entry.name)).toStrictEqual(["chart.png"]);
        expect(plan.skipped).toStrictEqual([
            { name: "noextension", reason: "unsupported-type" },
            { name: "page.html", reason: "unsupported-type" },
            { name: "run.sh", reason: "unsupported-type" },
        ]);
    });

    it("derives the type from the extension, case-insensitively", () => {
        const plan = planOutputCollection(new Map(), [file("REPORT.PDF"), file("data.XLSX"), file("plot.svg")]);

        expect(plan.collect.map((entry) => [entry.name, entry.mediaType])).toStrictEqual([
            ["REPORT.PDF", "application/pdf"],
            ["data.XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
            ["plot.svg", "image/svg+xml"],
        ]);
    });

    it("caps the size of one file", () => {
        const plan = planOutputCollection(new Map(), [file("big.csv", MAX_OUTPUT_FILE_BYTES + 1), file("ok.csv", MAX_OUTPUT_FILE_BYTES)]);

        expect(plan.collect.map((entry) => entry.name)).toStrictEqual(["ok.csv"]);
        expect(plan.skipped).toStrictEqual([{ name: "big.csv", reason: "too-large" }]);
    });

    it("caps the number of files", () => {
        const names = Array.from({ length: MAX_OUTPUT_FILES + 2 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
        const plan = planOutputCollection(
            new Map(),
            names.map((name) => file(name)),
        );

        expect(plan.collect).toHaveLength(MAX_OUTPUT_FILES);
        expect(plan.skipped.map((entry) => entry.reason)).toStrictEqual(["too-many", "too-many"]);
    });

    it("caps the total size across a run", () => {
        const size = MAX_OUTPUT_FILE_BYTES;
        const count = Math.floor(MAX_OUTPUT_TOTAL_BYTES / size);
        const plan = planOutputCollection(
            new Map(),
            Array.from({ length: count + 1 }, (_, index) => file(`part${String(index)}.zip`, size)),
        );

        expect(plan.collect).toHaveLength(count);
        expect(plan.skipped).toStrictEqual([{ name: `part${String(count)}.zip`, reason: "total-too-large" }]);
    });

    it("names files by their path under the output directory, without control characters", () => {
        expect(outputFileName(`${SANDBOX_OUTPUT_DIR}/charts/q3.png`)).toBe("charts/q3.png");
        expect(outputFileName(`${SANDBOX_OUTPUT_DIR}/bad\u{7}\nname.csv`)).toBe("badname.csv");

        const long = outputFileName(`${SANDBOX_OUTPUT_DIR}/${"x".repeat(300)}.pdf`);

        expect(long.length).toBeLessThanOrEqual(120);
        expect(long.endsWith(".pdf")).toBe(true);
    });
});

describe("collectSandboxOutputs", () => {
    it("creates the directory before the run and returns storage references, never URLs", async () => {
        let listing: SandboxEntry[] = [file("previous.png", 5, T0)];
        const { read, sandbox } = fakeSandbox(() => listing);
        const store = vi.fn(async (bytes: Uint8Array) => `agent-files/${await sha256Hex(bytes)}`);

        const before = await snapshotSandboxOutputs(sandbox);

        expect(sandbox.files.makeDir).toHaveBeenCalledWith(SANDBOX_OUTPUT_DIR);

        listing = [file("previous.png", 5, T0), file("chart.png", 3)];

        const outputs = await collectSandboxOutputs(sandbox, before, store);

        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(`${SANDBOX_OUTPUT_DIR}/chart.png`, { format: "bytes" });
        expect(store).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), { mediaType: "image/png", name: "chart.png" });
        expect(outputs.files).toStrictEqual([
            { mediaType: "image/png", name: "chart.png", size: 3, url: `storage:agent-files/${await sha256Hex(new Uint8Array([1, 2, 3]))}` },
        ]);
        expect(outputs.skippedFiles).toStrictEqual([]);
    });

    it("re-checks the size of the bytes actually read", async () => {
        const { sandbox } = fakeSandbox(
            () => [file("liar.csv", 10)],
            () => new Uint8Array(MAX_OUTPUT_FILE_BYTES + 1),
        );
        const store = vi.fn(async () => "agent-files/x");

        const outputs = await collectSandboxOutputs(sandbox, new Map(), store);

        expect(store).not.toHaveBeenCalled();
        expect(outputs).toStrictEqual({ files: [], skippedFiles: [{ name: "liar.csv", reason: "too-large" }] });
    });

    it("skips a file that fails to store and keeps the rest", async () => {
        const { sandbox } = fakeSandbox(() => [file("a.txt"), file("b.txt")]);
        const store = vi.fn(async (_bytes: Uint8Array, meta: { name: string }) => {
            if (meta.name === "a.txt") {
                throw new Error("R2 down");
            }

            return "agent-files/b";
        });

        const outputs = await collectSandboxOutputs(sandbox, new Map(), store);

        expect(outputs.files.map((entry) => entry.name)).toStrictEqual(["b.txt"]);
        expect(outputs.skippedFiles).toStrictEqual([{ name: "a.txt", reason: "failed" }]);
    });

    it("collects nothing when the run removed the directory", async () => {
        const sandbox: OutputSandbox = {
            files: {
                list: async () => {
                    throw new Error("not found");
                },
                makeDir: async () => true,
                read: async () => new Uint8Array(),
            },
        };

        await expect(collectSandboxOutputs(sandbox, new Map(), async () => "k")).resolves.toStrictEqual({ files: [], skippedFiles: [] });
    });

    it("tells the model where to write and what it may hand back", () => {
        expect(SANDBOX_OUTPUT_INSTRUCTIONS).toContain(SANDBOX_OUTPUT_DIR);
        expect(SANDBOX_OUTPUT_INSTRUCTIONS).toContain("xlsx");
    });
});

describe("sandbox output ownership", () => {
    const OWNER = "user-owner";
    const STRANGER = "user-stranger";
    const ORIGIN = "http://localhost:8788";

    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    /**
     * What `storeFile({ userId })` does to the database for the run's owner —
     * the R2 write aside, which the harness does not provide.
     */
    const storeAs =
        (userId: string) =>
        async (bytes: Uint8Array, meta: { mediaType: string; name: string }): Promise<string> => {
            const hash = await sha256Hex(bytes);
            const { storageId } = (await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(addFile, { filename: meta.name, hash, mediaType: meta.mediaType, storageId: `agent-files/${hash}`, userId }),
            )) as { storageId: string };

            return storageId;
        };

    const toolMessage = (output: unknown) => {
        return {
            content: [{ output: { type: "json", value: output }, toolCallId: "call-1", toolName: "codeExecution", type: "tool-result" }],
            role: "tool",
        };
    };

    it("is signed on read for the run's owner, and for nobody else", async () => {
        const { sandbox } = fakeSandbox(() => [file("report.pdf")]);
        const outputs = await collectSandboxOutputs(sandbox, new Map(), storeAs(OWNER));
        const [stored] = outputs.files;

        expect(stored?.url).toMatch(STORAGE_REF);

        const key = stored!.url.slice("storage:".length);
        const ownerKeys = await harness.run(async (ctx: any) => await ownedStorageKeys(ctx.db, OWNER, [key]));
        const strangerKeys = await harness.run(async (ctx: any) => await ownedStorageKeys(ctx.db, STRANGER, [key]));

        expect([...ownerKeys]).toStrictEqual([key]);
        expect([...strangerKeys]).toStrictEqual([]);

        const sign = vi.fn(async (signKey: string) => `${ORIGIN}/${signKey}?exp=1&method=GET&bucket=default&sig=fresh`);
        const message = toolMessage({ ...outputs, stdout: "" });

        // Read back as the owner's message: the reference becomes a fresh signed URL.
        const asOwner = await resolveStoredMedia(message, { allowedKeys: new Set(), origins: [ORIGIN], sign, toolKeys: ownerKeys });

        expect(JSON.stringify(asOwner.content)).toContain(`${ORIGIN}/${key}?exp=1&method=GET&bucket=default&sig=fresh`);
        expect(JSON.stringify(asOwner.content)).not.toContain("storage:");

        // The same result in a message owned by someone without the grant (a
        // copied or forged tool result) gets no URL at all.
        sign.mockClear();

        const asStranger = await resolveStoredMedia(message, { allowedKeys: new Set(), origins: [ORIGIN], sign, toolKeys: strangerKeys });
        const strangerFiles = (asStranger.content as { output: { value: { files: { url: string }[] } } }[])[0]!.output.value.files;

        expect(sign).not.toHaveBeenCalled();
        expect(strangerFiles[0]!.url).toBe(UNAVAILABLE_TOOL_STORAGE_URL);
    });
});
