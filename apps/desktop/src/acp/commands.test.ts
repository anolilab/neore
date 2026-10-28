/**
 * The receipt log around a relayed coding-agent command (`commands.ts`): the receipt is on disk before the command is
 * acted on, so a process killed between the claim and the receipt runs the command once when the call comes back,
 * and one killed after the receipt acknowledges it without running it again. "Killed" is a fresh `HostCommands` over the same
 * file, which is all a restart leaves behind.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AcpCommand } from "./commands";
import { HostCommands, isAcpEnvelope } from "./commands";

const SEND: AcpCommand = { kind: "send", sessionId: "s1", text: "fix it", turnId: "u1" };

let dir: string;
let receiptFile: string;

/** A core that prepares what the envelope says, and signs by writing the outcome into the payload. */
const fakeCore = (prepared: Record<string, unknown>) => {
    return {
        acpPrepare: (envelope: string): string => JSON.stringify({ expiresAt: Date.now() + 60_000, refusal: null, ...JSON.parse(envelope) as object, ...prepared }),
        acpSign: (envelope: string, _signature: string, outcome: string): string => JSON.stringify({ payload: JSON.stringify({ callId: (JSON.parse(envelope) as { callId: string }).callId, outcome }), signature: "signed" }),
    };
};

const envelopeFor = (callId: string, command: AcpCommand | null = SEND, refusal: string | null = null): string => JSON.stringify({ callId, command, refusal, tool: "acp_send" });

const outcomeOf = (signed: { payload: string }): string => (JSON.parse(signed.payload) as { outcome: string }).outcome;

const make = (applied: AcpCommand[], overrides: { apply?: (command: AcpCommand) => Promise<string> | string; file?: string; now?: () => number } = {}) =>
    new HostCommands({
        apply:
            overrides.apply
            ?? ((command) => {
                applied.push(command);

                return "accepted";
            }),
        core: fakeCore({}),
        now: overrides.now,
        receiptFile: overrides.file ?? receiptFile,
    });

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "neore-commands-"));
    receiptFile = path.join(dir, "receipts.json");
});

afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
});

describe("a coding-agent command", () => {
    it("is written to the receipt log before it is acted on, then signed accepted", async () => {
        const seen: string[] = [];
        const commands = make([], {
            apply: () => {
                seen.push(readFileSync(receiptFile, "utf8"));

                return "accepted";
            },
        });

        const signed = await commands.execute(envelopeFor("c1"), "sig");

        expect(outcomeOf(signed)).toBe("accepted");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("c1");
    });

    it("runs once when it comes back after the process died before the receipt", async () => {
        const applied: AcpCommand[] = [];

        // A receipt that cannot be written means the command is not acted on and the call is not acknowledged.
        writeFileSync(path.join(dir, "a-file"), "x");
        await expect(make(applied, { file: path.join(dir, "a-file", "receipts.json") }).execute(envelopeFor("c1"), "sig")).rejects.toThrow();
        expect(applied).toEqual([]);

        // The restarted process finds no receipt for it, runs it, and acknowledges any later delivery without running it again.
        const restarted = make(applied);

        expect(outcomeOf(await restarted.execute(envelopeFor("c1"), "sig"))).toBe("accepted");
        expect(applied).toEqual([SEND]);
        expect(outcomeOf(await restarted.execute(envelopeFor("c1"), "sig"))).toBe("accepted");
        expect(applied).toEqual([SEND]);
    });

    it("is acknowledged without running again when the process died after the receipt but before the call completed", async () => {
        const applied: AcpCommand[] = [];

        await make(applied).execute(envelopeFor("c1"), "sig");
        expect(applied).toEqual([SEND]);

        // The page never completed the call, the lease lapsed and the same call came back to a new process.
        const restarted = make(applied);
        const again = await restarted.execute(envelopeFor("c1"), "sig");

        expect(outcomeOf(again)).toBe("accepted");
        expect(applied).toEqual([SEND]);
    });

    it("runs once when it is delivered twice at the same moment", async () => {
        const applied: AcpCommand[] = [];
        const commands = make(applied);
        const [first, second] = await Promise.all([commands.execute(envelopeFor("c1"), "sig"), commands.execute(envelopeFor("c1"), "sig")]);

        expect([outcomeOf(first), outcomeOf(second)]).toEqual(["accepted", "accepted"]);
        expect(applied).toEqual([SEND]);
    });

    it("signs the core's refusal and leaves no receipt, so nothing was acted on", async () => {
        const applied: AcpCommand[] = [];
        const commands = make(applied);
        const signed = await commands.execute(envelopeFor("c1", null, "not approved on this computer"), "sig");

        expect(outcomeOf(signed)).toBe("not approved on this computer");
        expect(applied).toEqual([]);
        expect(() => readFileSync(receiptFile, "utf8")).toThrow();
    });

    it("signs a refusal when the command cannot be carried out, and looks at it again if it comes back", async () => {
        const applied: AcpCommand[] = [];
        const refusing = make(applied, {
            apply: () => {
                throw new Error("this session is still starting");
            },
        });

        expect(outcomeOf(await refusing.execute(envelopeFor("c1"), "sig"))).toBe("this session is still starting");
        // It did not run, so it holds no receipt: a delivery that comes back is a second try, and runs.
        expect(outcomeOf(await make(applied).execute(envelopeFor("c1"), "sig"))).toBe("accepted");
        expect(applied).toEqual([SEND]);
    });

    it("forgets a receipt once its envelope is long expired, and keeps the ones still live", async () => {
        const clock = { now: 1_000_000 };
        const commands = make([], { now: () => clock.now });

        await commands.execute(JSON.stringify({ callId: "old", command: SEND, expiresAt: 1_000_000 + 60_000, refusal: null, tool: "acp_send" }), "sig");
        clock.now += 60_000 + 11 * 60_000;
        await commands.execute(JSON.stringify({ callId: "new", command: SEND, expiresAt: clock.now + 60_000, refusal: null, tool: "acp_send" }), "sig");

        const stored = (JSON.parse(readFileSync(receiptFile, "utf8")) as { receipts: [string, number][] }).receipts.map(([callId]) => callId);

        expect(stored).toEqual(["new"]);
    });
});

describe("telling a coding-agent command from a device tool", () => {
    it("reads the tool name and nothing else, and treats anything unreadable as a device call", () => {
        expect(isAcpEnvelope('{"tool":"acp_send"}')).toBe(true);
        expect(isAcpEnvelope('{"tool":"acp_cancel"}')).toBe(true);
        expect(isAcpEnvelope('{"tool":"fs_read"}')).toBe(false);
        expect(isAcpEnvelope('{"tool":7}')).toBe(false);
        expect(isAcpEnvelope("not json")).toBe(false);
        expect(isAcpEnvelope("[]")).toBe(false);
    });
});
