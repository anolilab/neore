/**
 * The receipt log around a relayed coding-agent command (`commands.ts`): the receipt is on disk before the command is
 * acted on, so a process killed between the claim and the receipt runs the command once when the call comes back,
 * and one killed after the receipt acknowledges it without running it again. "Killed" is a fresh `HostCommands` over the same
 * file, which is all a restart leaves behind.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AcpCommand, AppliedCall, Held } from "./commands";
import { HELD, HostCommands, isAcpEnvelope } from "./commands";

const SEND: AcpCommand = { kind: "send", sessionId: "s1", text: "fix it", turnId: "u1" };

let directory: string;
let receiptFile: string;

/** A core that prepares what the envelope says, and signs by writing the outcome into the payload. */
const fakeCore = (prepared: Record<string, unknown>) => {
    return {
        acpPrepare: (envelope: string): string =>
            JSON.stringify({ expiresAt: Date.now() + 60_000, refusal: null, ...(JSON.parse(envelope) as object), ...prepared }),
        acpSign: (envelope: string, _signature: string, outcome: string): string =>
            JSON.stringify({ payload: JSON.stringify({ callId: (JSON.parse(envelope) as { callId: string }).callId, outcome }), signature: "signed" }),
    };
};

const envelopeFor = (callId: string, command: AcpCommand | null = SEND, refusal: string | null = null): string =>
    JSON.stringify({ callId, command, refusal, tool: "acp_send" });

const outcomeOf = (signed: { payload: string }): string => (JSON.parse(signed.payload) as { outcome: string }).outcome;

/** One delivery of a call, and the outcome that came back signed. */
const deliver = async (target: HostCommands, callId: string): Promise<string> => outcomeOf(await target.execute(envelopeFor(callId), "sig"));

const make = (
    applied: AcpCommand[],
    overrides: {
        apply?: (command: AcpCommand, call: AppliedCall) => Held | Promise<Held | string> | string;
        file?: string;
        interrupted?: (send: { sessionId: string; threadId: string; turnId: string }) => void;
        lapsed?: (send: { sessionId: string; threadId: string; turnId: string }) => void;
        now?: () => number;
    } = {},
) =>
    new HostCommands({
        apply:
            overrides.apply
            ?? ((command) => {
                applied.push(command);

                return "accepted";
            }),
        core: fakeCore({}),
        interrupted: overrides.interrupted,
        lapsed: overrides.lapsed,
        log: () => undefined,
        now: overrides.now,
        receiptFile: overrides.file ?? receiptFile,
    });

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "neore-commands-"));
    receiptFile = path.join(directory, "receipts.json");
});

afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
});

describe("a coding-agent command", () => {
    it("tells the applier which server it is for, and nothing for this computer", async () => {
        const calls: AppliedCall[] = [];
        const apply = (_command: AcpCommand, call: AppliedCall): string => {
            calls.push(call);

            return "accepted";
        };
        const forServer = new HostCommands({
            apply,
            core: fakeCore({ deviceId: "srv-1", server: "build-box" }),
            receiptFile,
        });
        const forComputer = new HostCommands({
            apply,
            core: fakeCore({ deviceId: "desk-1", server: null }),
            receiptFile: path.join(directory, "other.json"),
        });

        await forServer.execute(envelopeFor("c-server"), "sig");
        await forComputer.execute(envelopeFor("c-desk"), "sig");

        expect(calls[0]).toMatchObject({ callId: "c-server", deviceId: "srv-1", server: "build-box" });
        expect(calls[1]).toMatchObject({ callId: "c-desk" });
        expect(calls[1]?.deviceId).toBeUndefined();
        expect(calls[1]?.server).toBeUndefined();
    });

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
        writeFileSync(path.join(directory, "a-file"), "x");
        await expect(make(applied, { file: path.join(directory, "a-file", "receipts.json") }).execute(envelopeFor("c1"), "sig")).rejects.toThrow();
        expect(applied).toEqual([]);

        // The restarted process finds no receipt for it, runs it, and acknowledges any later delivery without running it again.
        const restarted = make(applied);

        expect(await deliver(restarted, "c1")).toBe("accepted");
        expect(applied).toEqual([SEND]);
        expect(await deliver(restarted, "c1")).toBe("accepted");
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

    it("signs a refusal when the command cannot be carried out, and refuses a delivery that comes back the same way", async () => {
        const applied: AcpCommand[] = [];
        const refusing = make(applied, {
            apply: () => {
                throw new Error("this session is still starting");
            },
        });

        expect(await deliver(refusing, "c1")).toBe("this session is still starting");
        // The call ended refused on the backend. The same envelope must not run later, in this process or after a restart.
        expect(await deliver(refusing, "c1")).toBe("this session is still starting");
        expect(await deliver(make(applied), "c1")).toBe("this session is still starting");
        expect(applied).toEqual([]);
    });

    it("makes a delivery that arrives while the first is being handled wait for its outcome", async () => {
        const applied: AcpCommand[] = [];
        const release: { go?: () => void } = {};
        const commands = make(applied, {
            apply: async (command) => {
                applied.push(command);
                await new Promise<void>((resolve) => {
                    release.go = resolve;
                });

                throw new Error("no such session");
            },
        });
        const first = deliver(commands, "c1");

        await vi.waitFor(() => expect(release.go).toBeDefined());

        const second = deliver(commands, "c1");

        release.go?.();

        // Not "accepted" because a receipt exists: the second sees what the first came to.
        expect(await Promise.all([first, second])).toEqual(["no such session", "no such session"]);
        expect(applied).toHaveLength(1);
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

const START: AcpCommand = {
    agentKey: "claude",
    agentLabel: "Claude",
    folderId: "f1",
    folderLabel: "neore",
    folderPath: "/work/neore",
    kind: "start",
    sessionId: "s1",
    threadId: "t1",
};

/** An envelope as the backend signs it: the tool, the thread and the ids a held send needs. */
const heldEnvelope = (callId: string, command: AcpCommand, expiresAt?: number): string =>
    JSON.stringify({
        callId,
        command,
        expiresAt,
        input: command.kind === "send" ? { sessionId: command.sessionId, text: command.text, turnId: command.turnId } : { sessionId: command.sessionId },
        refusal: null,
        threadId: "t1",
        tool: command.kind === "start" ? "acp_start" : "acp_send",
    });

const open = (file = receiptFile): string => readFileSync(file, "utf8");

/** One delivery of a call whose envelope names its tool, thread and ids, and the outcome that came back signed. */
const deliverHeld = async (target: HostCommands, callId: string, command: AcpCommand, expiresAt?: number): Promise<string> =>
    outcomeOf(await target.execute(heldEnvelope(callId, command, expiresAt), "sig"));

/** An `apply` that never returns: the process died inside it. */
const killedInside = (): Promise<string> =>
    new Promise<string>(() => {
        // Settles never.
    });

describe("a receipt log that cannot be read", () => {
    it.each(["{not json", "{}"])("stops a delivery instead of starting empty for %s", async (content) => {
        writeFileSync(receiptFile, content);

        const applied: AcpCommand[] = [];
        const commands = make(applied);

        await expect(deliver(commands, "c1")).rejects.toThrow();
        expect(applied).toEqual([]);
    });

    it("sets the unreadable log aside and runs commands again, from an empty log, once its commands have expired", async () => {
        writeFileSync(receiptFile, "{not json");

        let clock = 1_000_000;
        const applied: AcpCommand[] = [];
        const commands = make(applied, { now: () => clock });

        await expect(deliver(commands, "c1")).rejects.toThrow();
        expect(existsSync(receiptFile)).toBe(false);
        expect(readdirSync(directory).some((name) => name.includes(".unreadable-"))).toBe(true);

        clock += 14 * 60_000;
        await expect(deliver(commands, "c1")).rejects.toThrow();

        clock += 2 * 60_000;
        expect(await deliver(commands, "c1")).toBe("accepted");
        expect(applied).toEqual([SEND]);
    });

    it("starts empty at once when there is no log yet", async () => {
        const applied: AcpCommand[] = [];
        const fresh = make(applied, { file: path.join(directory, "missing.json") });

        expect(await deliver(fresh, "c2")).toBe("accepted");
        expect(applied).toEqual([SEND]);
    });
});

describe("a command held until its session opens", () => {
    it("is acknowledged with its envelope in the log, and the envelope leaves the log once it has been acted on", async () => {
        const commands = make([], { apply: () => HELD });

        expect(await deliverHeld(commands, "c1", SEND)).toBe("accepted");
        expect(open()).toContain("fix it");

        await commands.finished("c1");

        expect(open()).not.toContain("fix it");
        // Still acknowledged, not run again, when the call comes back.
        expect(await deliverHeld(commands, "c1", SEND)).toBe("accepted");
    });

    it("tells apply the call's id, thread and expiry", async () => {
        const seen: AppliedCall[] = [];
        const commands = make([], {
            apply: (_command, call) => {
                seen.push(call);

                return "accepted";
            },
        });

        await commands.execute(heldEnvelope("c1", SEND, 4_000_000_000_000), "sig");
        expect(seen).toEqual([{ callId: "c1", expiresAt: 4_000_000_000_000, threadId: "t1" }]);
    });

    it("drops the envelope as soon as the command was acted on, so a prompt that was sent does not stay on disk", async () => {
        await make([]).execute(heldEnvelope("c1", SEND), "sig");

        expect(open()).not.toContain("fix it");
    });

    it("loses no command when the process dies after the receipt: the next start acts on it once", async () => {
        // The first process writes the receipt and is killed before it acts. The `apply` that never returns stands in for
        // the kill: the receipt is on disk and nothing after it ran, which is all a killed process leaves.
        const killed = make([], { apply: killedInside });

        killed.execute(heldEnvelope("c1", START), "sig");
        await vi.waitFor(() => expect(open()).toContain("acp_start"));

        const applied: AcpCommand[] = [];
        const restarted = make(applied);

        await restarted.recover();
        expect(applied).toEqual([START]);

        // The call comes back as well (its lease lapsed): acknowledged, not run again.
        expect(await deliverHeld(restarted, "c1", START)).toBe("accepted");
        expect(applied).toEqual([START]);

        // And a start after that finds nothing left to do.
        const again: AcpCommand[] = [];

        await make(again).recover();
        expect(again).toEqual([]);
        expect(open()).not.toContain("acp_start");
    });

    it("ends a held message as interrupted, never runs it, when no replayed start will open its session", async () => {
        const killed = make([], { apply: killedInside });

        killed.execute(heldEnvelope("c1", SEND), "sig");
        await vi.waitFor(() => expect(open()).toContain("fix it"));

        const applied: AcpCommand[] = [];
        const interrupted: unknown[] = [];
        const lapsed: unknown[] = [];

        await make(applied, {
            interrupted: (held) => {
                interrupted.push(held);
            },
            lapsed: (held) => {
                lapsed.push(held);
            },
        }).recover();

        expect(applied).toEqual([]);
        expect(lapsed).toEqual([]);
        expect(interrupted).toEqual([{ sessionId: "s1", threadId: "t1", turnId: "u1" }]);
        expect(open()).not.toContain("fix it");
    });

    it("keeps a command that is still held across a restart, until it is acted on", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("c1", START), "sig");

        const calls: string[] = [];
        const second = make([], {
            apply: (_command, call) => {
                calls.push(call.callId);

                return HELD;
            },
        });

        await second.recover();
        await second.recover();
        // Held again by the new process, which replays it each time it starts until it is finished.
        expect(calls).toEqual(["c1", "c1"]);
        await second.finished("c1");

        const third: AcpCommand[] = [];

        await make(third).recover();
        expect(third).toEqual([]);
    });

    it("does not let a replay that fails block the commands that follow", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("c1", START), "sig");

        const logs: string[] = [];
        const applied: AcpCommand[] = [];
        const broken = new HostCommands({
            apply: (command) => {
                applied.push(command);

                return "accepted";
            },
            core: {
                acpPrepare: (envelope: string): string => {
                    if ((JSON.parse(envelope) as { callId: string }).callId === "c1") {
                        throw new Error("core unavailable");
                    }

                    return fakeCore({}).acpPrepare(envelope);
                },
                acpSign: fakeCore({}).acpSign,
            },
            log: (message) => {
                logs.push(message);
            },
            receiptFile,
        });

        await broken.recover();
        // The one that could not be checked was dropped; a new call still gets its answer.
        expect(await deliverHeld(broken, "c2", SEND)).toBe("accepted");
        expect(applied).toEqual([SEND]);
        expect(logs.join("\n")).toContain("was not valid any more");
    });

    it("replays a start before the message that waits for its session, whatever order they were received in", async () => {
        const order: string[] = [];
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("send", SEND), "sig");
        await first.execute(heldEnvelope("start", START), "sig");

        await make([], {
            apply: (command) => {
                order.push(command.kind);

                return "accepted";
            },
        }).recover();
        expect(order).toEqual(["start", "send"]);
    });

    it("checks the envelope with the core again, so consent revoked meanwhile stops a start", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("c1", START), "sig");

        const applied: AcpCommand[] = [];
        const revoking = new HostCommands({
            apply: (command) => {
                applied.push(command);

                return "accepted";
            },
            core: fakeCore({ command: null, refusal: "not approved on this computer" }),
            log: () => undefined,
            receiptFile,
        });

        await revoking.recover();
        expect(applied).toEqual([]);
        expect(await deliverHeld(revoking, "c1", START)).toBe("not approved on this computer");
    });

    it("fails the messages held for a start the core refuses now, and one it refuses itself, with the reason", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("start", START), "sig");
        await first.execute(heldEnvelope("send", SEND), "sig");
        await first.execute(heldEnvelope("start2", { ...START, sessionId: "s2" }), "sig");
        await first.execute(heldEnvelope("other", { ...SEND, sessionId: "s2", turnId: "u2" }), "sig");

        const applied: AcpCommand[] = [];
        const refused: { reason: string; send: unknown }[] = [];
        const revoking = new HostCommands({
            apply: (command) => {
                applied.push(command);

                return "accepted";
            },
            core: {
                acpPrepare: (envelope: string): string => {
                    const { callId } = JSON.parse(envelope) as { callId: string };

                    const refusals: Record<string, string> = { other: "consent revoked", start: "not approved" };
                    const refusal = refusals[callId];

                    return refusal === undefined ? fakeCore({}).acpPrepare(envelope) : fakeCore({ command: null, refusal }).acpPrepare(envelope);
                },
                acpSign: fakeCore({}).acpSign,
            },
            log: () => undefined,
            receiptFile,
            refused: (send, reason) => {
                refused.push({ reason, send });
            },
        });

        await revoking.recover();
        expect(applied.map((command) => command.kind)).toEqual(["start"]);
        expect(refused).toContainEqual({ reason: "not approved", send: { sessionId: "s1", threadId: "t1", turnId: "u1" } });
        expect(refused).toContainEqual({ reason: "consent revoked", send: { sessionId: "s2", threadId: "t1", turnId: "u2" } });
        expect(open()).not.toContain("fix it");
    });

    it("ends a replayed send's turn when apply throws during the replay", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("start", START), "sig");
        await first.execute(heldEnvelope("send", SEND), "sig");

        const refused: { reason: string; send: unknown }[] = [];
        const failing = new HostCommands({
            apply: (command) => {
                if (command.kind === "send") {
                    throw new Error("session gone");
                }

                return "accepted";
            },
            core: fakeCore({}),
            log: () => undefined,
            receiptFile,
            refused: (send, reason) => {
                refused.push({ reason, send });
            },
        });

        await failing.recover();
        expect(refused).toEqual([{ reason: "session gone", send: { sessionId: "s1", threadId: "t1", turnId: "u1" } }]);
    });

    it("does not act on a held command whose envelope has expired, and says so for a message", async () => {
        const clock = { now: 1_000_000 };
        const first = make([], { apply: () => HELD, now: () => clock.now });

        await first.execute(heldEnvelope("c1", SEND, 1_000_000 + 60_000), "sig");
        clock.now += 61_000;

        const applied: AcpCommand[] = [];
        const lapsed: unknown[] = [];

        await make(applied, {
            lapsed: (held) => {
                lapsed.push(held);
            },
            now: () => clock.now,
        }).recover();
        expect(applied).toEqual([]);
        expect(lapsed).toEqual([{ sessionId: "s1", threadId: "t1", turnId: "u1" }]);
        expect(open()).not.toContain("fix it");
    });

    it("makes a delivery wait for the replay, so a call that comes back during it is not acted on twice", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("c1", START), "sig");

        const release: { go?: () => void } = {};
        const applied: AcpCommand[] = [];
        const restarted = make(applied, {
            apply: async (command) => {
                applied.push(command);
                await new Promise<void>((resolve) => {
                    release.go = resolve;
                });

                return "accepted";
            },
        });
        const replay = restarted.recover();

        await vi.waitFor(() => expect(release.go).toBeDefined());

        const delivery = restarted.execute(heldEnvelope("c1", START), "sig");

        release.go?.();
        await replay;
        expect(outcomeOf(await delivery)).toBe("accepted");
        expect(applied).toHaveLength(1);
    });

    it("holds a delivery while the replay still waits for what it was told to wait for", async () => {
        const first = make([], { apply: () => HELD });

        await first.execute(heldEnvelope("c1", START), "sig");

        const gate: { open?: () => void } = {};
        const applied: AcpCommand[] = [];
        const restarted = make(applied);
        const replay = restarted.recover(
            new Promise<void>((resolve) => {
                gate.open = resolve;
            }),
        );
        const delivery = restarted.execute(heldEnvelope("c1", START), "sig");

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
        });
        expect(applied).toEqual([]);
        gate.open?.();
        await replay;
        await delivery;
        expect(applied).toHaveLength(1);
    });

    it("does not replay a cancel or an answer: the turn or request they belong to did not survive", async () => {
        const first = make([], {
            apply: killedInside,
        });

        first.execute(JSON.stringify({ callId: "c1", command: { kind: "cancel", sessionId: "s1", turnId: "u1" }, refusal: null, tool: "acp_cancel" }), "sig");
        await vi.waitFor(() => expect(open()).toContain("c1"));

        const applied: AcpCommand[] = [];

        await make(applied).recover();
        expect(applied).toEqual([]);
    });
});

describe("telling a coding-agent command from a device tool", () => {
    it("reads the tool name and nothing else, and treats anything unreadable as a device call", () => {
        expect(isAcpEnvelope("{\"tool\":\"acp_send\"}")).toBe(true);
        expect(isAcpEnvelope("{\"tool\":\"acp_cancel\"}")).toBe(true);
        expect(isAcpEnvelope("{\"tool\":\"fs_read\"}")).toBe(false);
        expect(isAcpEnvelope("{\"tool\":7}")).toBe(false);
        expect(isAcpEnvelope("not json")).toBe(false);
        expect(isAcpEnvelope("[]")).toBe(false);
    });
});
