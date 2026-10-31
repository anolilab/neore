/**
 * Which hooks file the person approved for which folder: one content hash per folder, kept in the app's data folder.
 * Only the local device window's channels write here (`device/index.ts`); a hooks file cannot approve itself, and
 * a changed file hashes differently, so it has no approval until the person gives one.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const MAX_FOLDERS = 200;

export class HookApprovals {
    private static read(file: string): Map<string, string> {
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { approvals?: Record<string, unknown> };
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

    /** The hash approved for this folder (its real path), if any. */
    public get(folder: string): string | undefined {
        return this.approvals.get(folder);
    }

    public approve(folder: string, hash: string): void {
        this.approvals.delete(folder);
        this.approvals.set(folder, hash);

        while (this.approvals.size > MAX_FOLDERS) {
            const [oldest] = this.approvals.keys();

            this.approvals.delete(oldest as string);
        }

        this.save();
    }

    public revoke(folder: string): void {
        if (this.approvals.delete(folder)) {
            this.save();
        }
    }

    private save(): void {
        const temporary = `${this.file}.tmp`;

        writeFileSync(temporary, JSON.stringify({ approvals: Object.fromEntries(this.approvals), version: 1 }), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}
