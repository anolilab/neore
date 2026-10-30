/**
 * Installing a registry agent: the user's consent, then the download. The window names an agent id and the
 * version it listed; everything else (archive, checksum, command) comes from the snapshot this process fetched,
 * and the same entry is shown in the consent dialog and installed. Checking the file against its published
 * SHA-256, unpacking it and registering the command are the core's (`device-core/src/acp_install.rs`); this
 * module only fetches bytes into the staging folder the core made, with a deadline and a size cap.
 */
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { DeviceCore } from "../device/types";
import type { AgentRegistry, ResolvedInstall } from "./registry";
import { fetchHttps } from "./registry";
import type { AcpView } from "./types";

/** Longer than any agent should need on a slow line, and the end of a stalled one. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export interface ConsentText {
    detail: string;
    message: string;
}

/** What the user is asked, built here from the registry entry: the window cannot word it. */
export const consentText = ({ agent, format, sha256, target }: ResolvedInstall): ConsentText => {
    return {
        detail: [
            `Publisher (as listed in the registry): ${agent.publisher}`,
            `Version: ${agent.version}`,
            `License: ${agent.license}`,
            agent.repository === "" ? undefined : `Repository: ${agent.repository}`,
            `Download: ${target.archive} (${format === "raw" ? "a single file" : format})`,
            `SHA-256 the registry published: ${sha256}`,
            // Each part quoted, so an argument with a space is one argument on screen as it is to the core.
            `Runs: ${[target.cmd, ...target.args].map((part) => JSON.stringify(part)).join(" ")}`,
            Object.keys(target.env).length === 0 ? undefined : `Sets: ${Object.keys(target.env).join(", ")}`,
            "",
            "Neore downloads this file, checks it against that checksum and installs it under its own app data. If the checksum does not match, nothing is installed.",
            "",
            "The agent runs on this computer with your rights, outside the shell sandbox. Installing approves no folder for it, and Neore never updates it on its own: a new version is a new install you confirm.",
        ]
            .filter((line) => line !== undefined)
            .join("\n"),
        message: `Install “${agent.name}” ${agent.version} from the ACP registry?`,
    };
};

export interface InstallerOptions {
    confirm: (text: ConsentText) => Promise<boolean>;
    core: () => Pick<DeviceCore, "acpInstall" | "acpInstallStage">;
    fetch?: typeof fetch;
    registry: AgentRegistry;
}

const countBytes = (max: number): Transform => {
    let received = 0;

    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;

            callback(received > max ? new Error("The download is larger than allowed.") : undefined, chunk);
        },
    });
};

/** Downloads `url` to `file`, which must not exist. https only, also after redirects. */
export const download = async (fetchImpl: typeof fetch, url: string, file: string): Promise<void> => {
    const response = await fetchHttps(fetchImpl, url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

    if (!response.ok || response.body === null) {
        await response.body?.cancel();

        throw new Error(`The download failed (${String(response.status)}).`);
    }

    if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) {
        await response.body.cancel();

        throw new Error("The download is larger than allowed.");
    }

    await pipeline(response.body as unknown as AsyncIterable<Uint8Array>, countBytes(MAX_DOWNLOAD_BYTES), createWriteStream(file, { flags: "wx", mode: 0o600 }));
};

export class AgentInstaller {
    private busy = false;

    public constructor(private readonly options: InstallerOptions) {}

    /**
     * Asks, downloads, hands the file to the core. `null` is a "no". One install at a time: a second click while
     * the dialog is open would stack dialogs the user cannot tell apart.
     */
    public async install(id: string, version: string): Promise<AcpView | null> {
        if (this.busy) {
            throw new Error("An install is already in progress.");
        }

        this.busy = true;

        try {
            const resolved = this.options.registry.resolve(id, version);

            if (!await this.options.confirm(consentText(resolved))) {
                return null;
            }

            return await this.fetchAndInstall(resolved);
        } finally {
            this.busy = false;
        }
    }

    private async fetchAndInstall({ agent, format, sha256, target }: ResolvedInstall): Promise<AcpView> {
        const core = this.options.core();
        const stage = core.acpInstallStage();

        try {
            const archive = path.join(stage, "download");

            await download(this.options.fetch ?? globalThis.fetch, target.archive, archive);

            // The core checks the file against `sha256`; whatever it answers, the staging folder goes below.
            return JSON.parse(
                core.acpInstall(
                    JSON.stringify({
                        archive,
                        args: target.args,
                        cmd: target.cmd,
                        env: target.env,
                        format,
                        key: agent.id,
                        label: agent.name,
                        publisher: agent.publisher,
                        sha256,
                        source: target.archive,
                        version: agent.version,
                    }),
                ),
            ) as AcpView;
        } finally {
            await rm(stage, { force: true, recursive: true });
        }
    }
}
