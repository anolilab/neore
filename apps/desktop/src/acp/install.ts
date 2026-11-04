/**
 * Installing a registry agent: the user's consent, then the download. The window names an agent id and the
 * version it listed; everything else (archive, checksum, command) comes from the snapshot this process fetched,
 * and the same entry is shown in the consent dialog and installed. Checking the file against its published
 * SHA-256, unpacking it and registering the command are the core's (`device-core/src/acp_install.rs`); this
 * module only fetches bytes into the staging folder the core made, with a deadline and a size cap.
 */
import { createWriteStream, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { DeviceCore } from "../device/types";
import type { NodeTools } from "./node-tools";
import { findNodeTools } from "./node-tools";
import type { NpmIndexEntry } from "./npm-index";
import { lookupNpmIntegrity, NPM_HOST } from "./npm-index";
import type { AgentRegistry, ResolvedInstall, ResolvedNpmInstall } from "./registry";
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

/**
 * What the user is asked for an npm agent. The hash is the package index's, read just now; the registry publishes
 * none for these agents, and the text says so rather than letting it look like the publisher's.
 */
export const npmConsentText = ({ agent, args, env, name, version }: ResolvedNpmInstall, entry: NpmIndexEntry, tools: NodeTools): ConsentText => {
    return {
        detail: [
            `Publisher (as listed in the registry): ${agent.publisher}`,
            `Package: ${name}`,
            `Version: ${version}`,
            `License: ${agent.license}`,
            agent.repository === "" ? undefined : `Repository: ${agent.repository}`,
            `Hash (SHA-512): ${entry.integrity}`,
            `Download: ${entry.tarball}`,
            // Each part quoted, so an argument with a space is one argument on screen as it is to the core.
            `Runs: ${[tools.node, `<the package's program>`, ...args].map((part) => JSON.stringify(part)).join(" ")}`,
            Object.keys(env).length === 0 ? undefined : `Sets: ${Object.keys(env).join(", ")}`,
            "",
            "The registry publishes no hash for this agent. This hash came from the npm package index just now, not from the publisher: you are trusting the index as it is today (trust on first use). Neore downloads the package, checks it against this hash and refuses to install it if it differs.",
            "",
            "npm installs it into Neore's own app data without running any install script. The files it installs, its dependencies included, are hashed after the install and checked before every start: if one changes, Neore will not start the agent.",
            "",
            "The agent runs on this computer with your rights, outside the shell sandbox. Installing approves no folder for it, and Neore never updates it on its own: a newer version is a new install you confirm.",
        ]
            .filter((line) => line !== undefined)
            .join("\n"),
        message: `Install “${agent.name}” ${version} from npm (${name})?`,
    };
};

export interface InstallerOptions {
    confirm: (text: ConsentText) => Promise<boolean>;
    core: () => Pick<DeviceCore, "acpInstall" | "acpInstallNpm" | "acpInstallStage">;
    fetch?: typeof fetch;
    /** Where node and npm are; the default searches `PATH` and the usual package-manager folders. */
    locateTools?: () => NodeTools | undefined;
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

const realpathOr = (file: string): string => {
    try {
        return realpathSync(file);
    } catch {
        return file;
    }
};

/** Downloads `url` to `file`, which must not exist. https only, also after redirects. */
export const download = async (fetchImpl: typeof fetch, url: string, file: string, onlyHost?: string): Promise<void> => {
    const response = await fetchHttps(fetchImpl, url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }, onlyHost);

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

            if (resolved.kind === "npm") {
                return await this.installNpm(resolved);
            }

            if (!await this.options.confirm(consentText(resolved))) {
                return null;
            }

            return await this.fetchAndInstall(resolved);
        } finally {
            this.busy = false;
        }
    }

    /**
     * The tools and the index's hash are found BEFORE the dialog, so it shows what will be checked and an install
     * that cannot happen (no node, no hash) never asks. Nothing is downloaded until the answer is yes.
     */
    private async installNpm(resolved: ResolvedNpmInstall): Promise<AcpView | null> {
        const found = (this.options.locateTools ?? (() => findNodeTools()))();

        if (found === undefined) {
            throw new Error("Node.js and npm were not found. Install Node.js (which includes npm), then try again.");
        }

        // The core records the resolved path of node; the dialog shows that one, not a link that may be re-pointed.
        const tools = { ...found, node: realpathOr(found.node) };

        const fetchImpl = this.options.fetch ?? globalThis.fetch;
        const entry = await lookupNpmIntegrity(fetchImpl, resolved.name, resolved.version);

        if (!await this.options.confirm(npmConsentText(resolved, entry, tools))) {
            return null;
        }

        const core = this.options.core();
        const stage = core.acpInstallStage();

        try {
            const archive = path.join(stage, "download");

            await download(fetchImpl, entry.tarball, archive, NPM_HOST);

            // The core checks the file against `integrity` (the index's, as confirmed); whatever it answers, the
            // staging folder goes below.
            return JSON.parse(
                await core.acpInstallNpm(
                    JSON.stringify({
                        archive,
                        args: resolved.args,
                        env: resolved.env,
                        integrity: entry.integrity,
                        key: resolved.agent.id,
                        label: resolved.agent.name,
                        node: found.node,
                        nodeResolved: tools.node,
                        npm: tools.npm,
                        package: resolved.name,
                        publisher: resolved.agent.publisher,
                        source: entry.tarball,
                        version: resolved.version,
                    }),
                ),
            ) as AcpView;
        } finally {
            await rm(stage, { force: true, recursive: true });
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
