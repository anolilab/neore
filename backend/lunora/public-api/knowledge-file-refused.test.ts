/**
 * A knowledge file the quota refuses leaves no vault file behind: the staged
 * upload is already spent, so the row `saveVaultFile` made would be unreachable.
 */
import { describe, expect, it, vi } from "vitest";

import { ROUTES } from "./routes";

const route = ROUTES.find((candidate) => candidate.operationId === "createKnowledgeFile")!;

const FILE = { fileId: "file-1", fileSize: 10, fileType: "text/plain" };

const call = async (ctx: unknown) => await route.handler({ body: { name: "a.txt", uploadId: "up-1" }, ctx, identity: { userId: "user-1" } } as never);

describe("createKnowledgeFile", () => {
    it("deletes the vault file and rethrows the refusal when addFile throws", async () => {
        const refusal = new Error("quota");
        const runMutation = vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
            if ("vaultFileId" in args) {
                throw refusal;
            }

            return null;
        });
        const runAction = vi.fn(async () => FILE);

        await expect(call({ runAction, runMutation })).rejects.toBe(refusal);
        expect(runMutation).toHaveBeenCalledTimes(2);
        expect(runMutation.mock.calls[1]?.[1]).toEqual({ fileId: "file-1", userId: "user-1" });
    });

    it("still surfaces the refusal when the cleanup fails too", async () => {
        const refusal = new Error("quota");
        const runMutation = vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
            throw "vaultFileId" in args ? refusal : new Error("cleanup failed");
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(call({ runAction: vi.fn(async () => FILE), runMutation })).rejects.toBe(refusal);
        log.mockRestore();
    });

    it("keeps the vault file when the knowledge file is added", async () => {
        const runMutation = vi.fn(async () => "kf-1");

        await expect(call({ runAction: vi.fn(async () => FILE), runMutation })).resolves.toMatchObject({ data: { id: "kf-1" }, status: 201 });
        expect(runMutation).toHaveBeenCalledOnce();
    });
});
