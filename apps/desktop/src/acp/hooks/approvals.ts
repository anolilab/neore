/**
 * Which hooks file the person approved for which agent in which folder: one content hash per (agent, folder), kept in
 * the app's data folder. Another agent in the same folder starts with nothing approved.
 * Only the local device window's channels write here (`device/index.ts`); a hooks file cannot approve itself, and
 * a changed file hashes differently, so it has no approval until the person gives one.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const MAX_FOLDERS = 200;
/** Version 1 keyed an approval by folder alone; those are not read, so nothing they approved still counts. */
const VERSION = 2;

/** A key that cannot be read two ways: the pair is JSON, so no choice of names runs together. */
const keyOf = (agentKey: string, folder: string): string => JSON.stringify([agentKey, folder]);

export class HookApprovals {
    private static read(file: string): Map<string, string> {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { approvals?: Record<string, unknown>; version?: number };

            if (parsed.version !== VERSION) {
                return new Map();
            }

            const entries = Object.entries(parsed.approvals ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");

            return new Map(entries);
        } catch {
            // Missing or damaged: nothing is approved, which is the safe answer.
            return new Map();
        }
    }

    private approvals = new Map<string, string>();

    public constructor(private readonly file: string) {
        this.approvals = HookApprovals.read(file);
    }

    /** The hash approved for this agent in this folder (its real path), if any. */
    public get(agentKey: string, folder: string): string | undefined {
        return this.approvals.get(keyOf(agentKey, folder));
    }

    public approve(agentKey: string, folder: string, hash: string): void {
        const key = keyOf(agentKey, folder);

        this.approvals.delete(key);
        this.approvals.set(key, hash);

        while (this.approvals.size > MAX_FOLDERS) {
            const [oldest] = this.approvals.keys();

            this.approvals.delete(oldest as string);
        }

        this.save();
    }

    public revoke(agentKey: string, folder: string): void {
        const key = keyOf(agentKey, folder);
        const hash = this.approvals.get(key);

        if (hash === undefined) {
            return;
        }

        this.approvals.delete(key);

        try {
            this.save();
        } catch (error) {
            // Still approved on disk, so still approved here: a retry must find it and save the revoke.
            this.approvals.set(key, hash);

            throw error;
        }
    }

    private save(): void {
        const temporary = `${this.file}.tmp`;

        writeFileSync(temporary, JSON.stringify({ approvals: Object.fromEntries(this.approvals), version: VERSION }), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
