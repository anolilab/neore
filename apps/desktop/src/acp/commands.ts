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

export interface CommandOptions {
    /** Acts on a command and answers `accepted`, or the reason it was not carried out. Throws to refuse with the error's message. */
    apply: (command: AcpCommand) => Promise<string> | string;
    core: CommandCore;
    now?: () => number;
    /** Under the app's data folder. */
    receiptFile: string;
}

export const ACCEPTED = "accepted";

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

/** What the log keeps of a call: when its envelope expires, and why the command was refused if it was. */
interface Receipt {
    expiresAt: number;
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

export class HostCommands {
    /** callId → receipt. In memory first, so two deliveries at once cannot both run. */
    private readonly receipts = new Map<string, Receipt>();

    /** Deliveries being handled now. A second delivery of the same call waits for the first's outcome instead of guessing it. */
    private readonly handling = new Map<string, Promise<string>>();

    private loaded: Promise<void> | undefined;

    /** Serialises writes of the receipt file; a write never overtakes the one before it. */
    private writing: Promise<void> = Promise.resolve();

    public constructor(private readonly options: CommandOptions) {}

    public async execute(envelope: string, signature: string): Promise<Signed> {
        await this.load();

        const { core } = this.options;
        const prepared = JSON.parse(core.acpPrepare(envelope, signature)) as Prepared;
        const outcome = await this.outcomeOf(prepared);

        return JSON.parse(core.acpSign(envelope, signature, outcome)) as Signed;
    }

    private async outcomeOf(prepared: Prepared): Promise<string> {
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

        const first = this.receive(prepared.command, callId, prepared.expiresAt);

        this.handling.set(callId, first);

        try {
            return await first;
        } finally {
            this.handling.delete(callId);
        }
    }

    /** The receipt is on disk before the command is acted on; a refusal is written beside it, so it stays a refusal. */
    private async receive(command: AcpCommand, callId: string, expiresAt: number): Promise<string> {
        const receipt: Receipt = { expiresAt };

        this.receipts.set(callId, receipt);

        try {
            await this.persist();
        } catch (error) {
            this.receipts.delete(callId);

            throw error;
        }

        let outcome: string;

        try {
            outcome = await this.options.apply(command);
        } catch (error) {
            outcome = (error as Error).message.slice(0, 200) || "refused";
        }

        if (outcome !== ACCEPTED) {
            receipt.refusal = outcome;

            try {
                await this.persist();
            } catch {
                // The refusal is still signed. Without it on disk, a redelivery after a restart reads as carried out.
            }
        }

        return outcome;
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
                    this.receipts.set(entry[0], { expiresAt: entry[1], ...typeof entry[2] === "string" && { refusal: entry[2] } });
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
        const content = JSON.stringify({ receipts: [...this.receipts].map(([callId, { expiresAt, refusal }]) => refusal === undefined ? [callId, expiresAt] : [callId, expiresAt, refusal]) });
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
