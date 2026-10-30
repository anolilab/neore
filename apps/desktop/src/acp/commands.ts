/**
 * The coding-agent commands the backend sends (`acp_start`, `acp_send`, `acp_cancel`, `acp_permission_answer`;
 * plans/acp-agent-host.md §4.1), from the relayed envelope to the signed result.
 *
 * The core verifies and decides what may be done (`device-core/src/acp_call.rs`); this carries it out, in an order
 * that makes a redelivery safe:
 *
 * 1. the core checks the call and hands back the command, spending no nonce;
 * 2. **the receipt is written, durably, before the command is acted on**, keyed by the signed call id;
 * 3. the command is acted on;
 * 4. the core signs the result, which the page completes the call with.
 *
 * A call whose claim lapses is delivered again under the same envelope. Killed between the claim and step 2, the
 * redelivery finds no receipt and runs the command, once. Killed after step 2, it finds the receipt and is
 * acknowledged without running again, whatever happened to the command after the receipt (a command the process
 * did not finish acting on is lost, and the turn it belonged to ends through the backend's own timeouts).
 *
 * The receipt log is the replay defence for these calls: a captured envelope can be delivered again, and finds
 * its receipt, until the envelope expires. Receipts are kept for that long and a little more.
 *
 * **A command that is not carried out yet stays in the log.** `start` and `send` are kept with their signed envelope
 * until they are acted on (plans/acp-agent-host.md §4.6): a `send` for a session that is still opening is held by the
 * caller (`early-sends.ts`) and the receipt says so (`apply` answers {@link HELD}); a `start` is acted on when its
 * agent has opened, or failed to. {@link HostCommands.recover}, at app start, runs the ones a dead process left in
 * that state, once: it checks the envelope with the core again (consent revoked meanwhile, expiry), and a command
 * that has been acted on has its envelope removed, so the prompt text does not stay on disk. The window between a
 * command being acted on and that write is not atomic: a process killed inside it acts on the command twice.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { Signed } from "../device/types";

/** Receipts outlive their envelope by this much, so clock skew cannot reopen a call. */
const KEEP_AFTER_EXPIRY_MS = 10 * 60_000;
/** The backend allows three open commands per device and each lives five minutes, so this is far more than can be live. */
const MAX_RECEIPTS = 1000;

export type AcpCommand
    = | { kind: "cancel"; sessionId: string; turnId: string }
        | { kind: "permissionAnswer"; optionId: string; requestId: string; sessionId: string }
        | { kind: "send"; sessionId: string; text: string; turnId: string }
        | { agentKey: string; agentLabel: string; folderId: string; folderLabel: string; folderPath: string; kind: "start"; sessionId: string; threadId: string };

interface Prepared {
    callId: string;
    command: AcpCommand | null;
    expiresAt: number;
    refusal: string | null;
}

/** The part of the core these steps use. */
export interface CommandCore {
    acpPrepare: (envelope: string, signature: string) => string;
    acpSign: (envelope: string, signature: string, outcome: string) => string;
}

/** What a command's `apply` is told about its call. */
export interface AppliedCall {
    callId: string;
    expiresAt: number;
    /** The thread the backend made the call for; absent only for an envelope that carried none. */
    threadId?: string;
}

/** `apply` kept the command for later (a send for a session that is not open yet): the call is acknowledged, the receipt stays open until {@link HostCommands.finished}. */
export interface Held {
    held: true;
}

/** A `send` that was held past its envelope's expiry, found by {@link HostCommands.recover}: its stream must end with an error. */
export interface LapsedSend {
    sessionId: string;
    threadId: string;
    turnId: string;
}

export interface CommandOptions {
    /** Acts on a command and answers `accepted`, or the reason it was not carried out. Throws to refuse with the error's message. */
    apply: (command: AcpCommand, call: AppliedCall) => Held | Promise<Held | string> | string;
    core: CommandCore;
    /** Told of a held `send` whose session no replayed start will open: it may have run before the app went down. */
    interrupted?: (send: LapsedSend) => void;
    /** Told of a held `send` that expired while the app was down. */
    lapsed?: (send: LapsedSend) => void;
    log?: (message: string) => void;
    now?: () => number;
    /** Under the app's data folder. */
    receiptFile: string;
    /** Told of a held `send` that will not run: the core would not allow it any more, or the start it waited for was refused. */
    refused?: (send: LapsedSend, reason: string) => void;
}

export const ACCEPTED = "accepted";
export const HELD: Held = { held: true };

/** The commands worth running after a restart: the others (a cancel, an answer) belong to a turn or request that did not survive it. */
const isReplayable = (command: AcpCommand): boolean => command.kind === "start" || command.kind === "send";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a relayed envelope is a coding-agent command. Routing only: the core verifies it before anything is done. */
export const isAcpEnvelope = (envelope: string): boolean => {
    try {
        const parsed: unknown = JSON.parse(envelope);

        return isRecord(parsed) && typeof parsed.tool === "string" && parsed.tool.startsWith("acp_");
    } catch {
        return false;
    }
};

/** A failed write must not stop the writes queued behind it. */
const settle = async (write: Promise<void>): Promise<void> => {
    try {
        await write;
    } catch {
        // The caller of that write sees the error.
    }
};

/** What the log keeps of a call: when its envelope expires, why the command was refused if it was, and the signed envelope while it has not been acted on. */
interface Receipt {
    expiresAt: number;
    /** Set from the receipt until the command is acted on. */
    held?: { envelope: string; signature: string };
    refusal?: string;
}

/** Makes the rename itself durable. Windows cannot open a folder to sync it, and does not need to. */
const syncDirectory = async (directory: string): Promise<void> => {
    if (process.platform === "win32") {
        return;
    }

    const handle = await open(directory, "r");

    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

const parsedEnvelope = (envelope: string): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(envelope);

        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

const threadOf = (envelope: string): string | undefined => {
    const { threadId } = parsedEnvelope(envelope);

    return typeof threadId === "string" && threadId !== "" ? threadId : undefined;
};

/** The session a held `start` opens, from its stored envelope; "" for anything else. */
const startedSessionOf = (envelope: string): string => {
    const { input, tool } = parsedEnvelope(envelope);

    return tool === "acp_start" && isRecord(input) && typeof input.sessionId === "string" ? input.sessionId : "";
};

/** A held `send`'s ids, from its stored envelope. */
const sendOf = (envelope: string): LapsedSend | undefined => {
    const { input, threadId, tool } = parsedEnvelope(envelope);
    const fields = isRecord(input) ? input : {};

    return tool === "acp_send" && typeof threadId === "string" && typeof fields.sessionId === "string" && typeof fields.turnId === "string"
        ? { sessionId: fields.sessionId, threadId, turnId: fields.turnId }
        : undefined;
};

/** One receipt as the file holds it: `[id, expiresAt]`, plus the refusal, or `[id, expiresAt, null, envelope, signature]` while it is held. */
const entryOf = (callId: string, { expiresAt, held, refusal }: Receipt): (number | string | null)[] => {
    if (held !== undefined) {
        return [callId, expiresAt, null, held.envelope, held.signature];
    }

    return refusal === undefined ? [callId, expiresAt] : [callId, expiresAt, refusal];
};

export class HostCommands {
    /** callId → receipt. In memory first, so two deliveries at once cannot both run. */
    private readonly receipts = new Map<string, Receipt>();

    /** Deliveries being handled now. A second delivery of the same call waits for the first's outcome instead of guessing it. */
    private readonly handling = new Map<string, Promise<string>>();

    private loaded: Promise<void> | undefined;

    /** Set while `recover` runs: a delivery waits for it, so a redelivered call cannot be acted on twice. */
    private replaying: Promise<void> | undefined;

    /** Serialises writes of the receipt file; a write never overtakes the one before it. */
    private writing: Promise<void> = Promise.resolve();

    public constructor(private readonly options: CommandOptions) {}

    public async execute(envelope: string, signature: string): Promise<Signed> {
        await this.load();
        await this.replaying;

        const { core } = this.options;
        const prepared = JSON.parse(core.acpPrepare(envelope, signature)) as Prepared;
        const outcome = await this.outcomeOf(prepared, envelope, signature);

        return JSON.parse(core.acpSign(envelope, signature, outcome)) as Signed;
    }

    /** A held command has been acted on (or failed to be): its envelope leaves the log. */
    public async finished(callId: string): Promise<void> {
        const receipt = this.receipts.get(callId);

        if (receipt?.held === undefined) {
            return;
        }

        delete receipt.held;

        try {
            await this.persist();
        } catch {
            // The next write carries it; at worst a restart acts on the command once more, within its expiry.
        }
    }

    /**
     * Acts on the commands a previous run left unfinished, once, starts before sends. Call at app start, before the
     * relay delivers anything: a delivery waits for this. `before` is something the replay must wait for; the gate is
     * up while it is pending, so a delivery arriving in that gap is not acted on ahead of the replay and again by it.
     */
    public async recover(before?: Promise<unknown>): Promise<void> {
        this.replaying = this.replayAfter(before);

        await this.replaying;
    }

    private async replayAfter(before: Promise<unknown> | undefined): Promise<void> {
        await before;
        await this.replayAll();
    }

    private async outcomeOf(prepared: Prepared, envelope: string, signature: string): Promise<string> {
        if (prepared.command === null) {
            // The core would not allow it: nothing was acted on, so there is nothing to remember.
            return prepared.refusal ?? "refused";
        }

        const { callId } = prepared;
        const running = this.handling.get(callId);

        if (running !== undefined) {
            return await running;
        }

        const known = this.receipts.get(callId);

        if (known !== undefined) {
            // A redelivery: the first delivery got as far as its receipt and is not run again. Carried out, it is
            // acknowledged; refused, it is refused the same way, since the call must end as it did the first time.
            return known.refusal ?? ACCEPTED;
        }

        const first = this.receive(prepared.command, { callId, expiresAt: prepared.expiresAt, threadId: threadOf(envelope) }, { envelope, signature });

        this.handling.set(callId, first);

        try {
            return await first;
        } finally {
            this.handling.delete(callId);
        }
    }

    /**
     * The receipt is on disk before the command is acted on; a refusal is written beside it, so it stays a refusal. A
     * command that can be replayed carries its envelope in the receipt until it has been acted on.
     */
    private async receive(command: AcpCommand, call: AppliedCall, signed: { envelope: string; signature: string }): Promise<string> {
        const { callId } = call;
        const receipt: Receipt = { expiresAt: call.expiresAt, ...isReplayable(command) && { held: signed } };

        this.receipts.set(callId, receipt);

        try {
            await this.persist();
        } catch (error) {
            this.receipts.delete(callId);

            throw error;
        }

        return await this.act(command, call);
    }

    /** Acts on a command whose receipt is on disk, and records what came of it. */
    private async act(command: AcpCommand, call: AppliedCall): Promise<string> {
        const receipt = this.receipts.get(call.callId) as Receipt;
        let outcome: Held | string;

        try {
            outcome = await this.options.apply(command, call);
        } catch (error) {
            outcome = (error as Error).message.slice(0, 200) || "refused";
        }

        if (typeof outcome !== "string") {
            // Kept by the caller: the call is acknowledged and the receipt stays open until `finished`.
            return ACCEPTED;
        }

        delete receipt.held;

        if (outcome !== ACCEPTED) {
            receipt.refusal = outcome;
        }

        try {
            await this.persist();
        } catch {
            // The outcome is still signed. Without it on disk, a redelivery after a restart reads as carried out
            // (or, for a command acted on, runs again from its envelope: see the header on the window).
        }

        return outcome;
    }

    /** A replay that fails is logged, not kept: a delivery waits for it and must not wait for ever. */
    private async replayAll(): Promise<void> {
        try {
            await this.replay();
        } catch (error) {
            this.options.log?.(`[acp-host] commands left from the last run could not be replayed: ${(error as Error).message}`);
        }
    }

    private async replay(): Promise<void> {
        await this.load();

        const pending = [...this.receipts].filter(([, receipt]) => receipt.held !== undefined);

        // A session must exist before the message waiting for it is held against it.
        pending.sort(
            ([, first], [, second]) =>
                Number(parsedEnvelope(second.held?.envelope ?? "").tool === "acp_start")
                - Number(parsedEnvelope(first.held?.envelope ?? "").tool === "acp_start"),
        );

        // The sessions a replayed start will open. A held message for any other session is for one that died with the
        // process or whose start has not come back yet: it may already have run, so its turn is interrupted.
        const opening = new Set(pending.flatMap(([, receipt]) => receipt.expiresAt > this.now() ? [startedSessionOf(receipt.held?.envelope ?? "")] : []));
        // A start the core refuses on this run opens nothing: the messages held for it fail with its reason.
        const refusedStarts = new Map<string, string>();

        for (const [callId, receipt] of pending) {
            // eslint-disable-next-line no-await-in-loop -- one command at a time, starts first
            await this.replayHeld(callId, receipt, opening, refusedStarts);
        }
    }

    private async replayHeld(callId: string, receipt: Receipt, opening: Set<string>, refusedStarts: Map<string, string>): Promise<void> {
        const { envelope, signature } = receipt.held as { envelope: string; signature: string };
        const send = sendOf(envelope);

        if (receipt.expiresAt <= this.now()) {
            if (send !== undefined) {
                this.options.lapsed?.(send);
            }

            await this.finished(callId);

            return;
        }

        const refusal = send === undefined ? undefined : refusedStarts.get(send.sessionId);

        if (send !== undefined && refusal !== undefined) {
            this.options.refused?.(send, refusal);
            await this.finished(callId);

            return;
        }

        if (send !== undefined && !opening.has(send.sessionId)) {
            this.options.interrupted?.(send);
            await this.finished(callId);

            return;
        }

        const refused = await this.replayOne(callId, envelope, signature);
        const started = startedSessionOf(envelope);

        if (refused !== undefined && started !== "") {
            opening.delete(started);
            refusedStarts.set(started, refused);
        }
    }

    /** Answers why the command was dropped, or `undefined` when it was acted on. */
    private async replayOne(callId: string, envelope: string, signature: string): Promise<string | undefined> {
        let prepared: Prepared;

        try {
            // The core checks again what it checked the first time, and consent too: the user may have revoked it since.
            prepared = JSON.parse(this.options.core.acpPrepare(envelope, signature)) as Prepared;
        } catch (error) {
            const reason = (error as Error).message;

            this.options.log?.(`[acp-host] a command left from the last run was not valid any more and was dropped: ${reason}`);
            this.refuse(envelope, reason);
            await this.finished(callId);

            return reason;
        }

        if (prepared.command === null) {
            const reason = prepared.refusal ?? "refused";

            this.options.log?.(`[acp-host] a command left from the last run is not allowed any more and was dropped: ${reason}`);
            this.refuse(envelope, reason);

            const receipt = this.receipts.get(callId) as Receipt;

            delete receipt.held;
            receipt.refusal = reason;

            try {
                await this.persist();
            } catch {
                // The next write carries it.
            }

            return reason;
        }

        const running = this.act(prepared.command, { callId, expiresAt: prepared.expiresAt, threadId: threadOf(envelope) });

        this.handling.set(callId, running);

        try {
            await running;
        } finally {
            this.handling.delete(callId);
        }

        return undefined;
    }

    /** A replayed `send` that was dropped ends its turn with the reason, instead of leaving it to the backend's timeouts. */
    private refuse(envelope: string, reason: string): void {
        const send = sendOf(envelope);

        if (send !== undefined) {
            this.options.refused?.(send, reason);
        }
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private load(): Promise<void> {
        this.loaded ??= this.read();

        return this.loaded;
    }

    private async read(): Promise<void> {
        try {
            const parsed: unknown = JSON.parse(await readFile(this.options.receiptFile, "utf8"));
            const entries = isRecord(parsed) && Array.isArray(parsed.receipts) ? parsed.receipts : [];

            for (const entry of entries) {
                if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
                    this.receipts.set(entry[0], {
                        expiresAt: entry[1],
                        ...typeof entry[2] === "string" && { refusal: entry[2] },
                        ...typeof entry[3] === "string" && typeof entry[4] === "string" && { held: { envelope: entry[3], signature: entry[4] } },
                    });
                }
            }
        } catch {
            // No file yet, or one that cannot be read: the log starts empty. A call it forgot can run again only
            // while its envelope is valid, and the backend's own claim keeps a second window from taking it.
        }
    }

    /** Drops what has expired, then writes the log after the writes already queued. Rejects when the file cannot be written. */
    private async persist(): Promise<void> {
        const cutoff = this.now() - KEEP_AFTER_EXPIRY_MS;

        for (const [callId, { expiresAt }] of this.receipts) {
            if (expiresAt < cutoff) {
                this.receipts.delete(callId);
            }
        }

        while (this.receipts.size > MAX_RECEIPTS) {
            const [oldest] = this.receipts.keys();

            this.receipts.delete(oldest as string);
        }

        const write = this.writeAfter(this.writing);

        this.writing = settle(write);
        await write;
    }

    private async writeAfter(previous: Promise<void>): Promise<void> {
        await previous;
        await this.write();
    }

    private async write(): Promise<void> {
        const { receiptFile } = this.options;

        await mkdir(path.dirname(receiptFile), { recursive: true });
        const content = JSON.stringify({ receipts: [...this.receipts].map(([callId, receipt]) => entryOf(callId, receipt)) });
        const handle = await open(`${receiptFile}.tmp`, "w", 0o600);

        try {
            await handle.writeFile(content);
            // On disk, not in the page cache: the receipt is the only thing that stops a redelivered command running twice.
            await handle.sync();
        } finally {
            await handle.close();
        }

        await rename(`${receiptFile}.tmp`, receiptFile);
        await syncDirectory(path.dirname(receiptFile));
    }
}
