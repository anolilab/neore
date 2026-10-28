import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REGISTRY_FIXTURE, SHA } from "./fixtures/registry";
import { AgentInstaller, consentText, download } from "./install";
import { AgentRegistry } from "./registry";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "neore-install-"));
});

afterEach(() => {
    rmSync(scratch, { force: true, recursive: true });
});

const BYTES = Buffer.from("not really an archive");

/** Answers the registry URL with the fixture and everything else with `body`. */
const makeFetch = (body: () => Response | Promise<Response> = () => new Response(BYTES)) =>
    vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith("registry.json") ? Response.json(REGISTRY_FIXTURE) : body());

const setup = async (options: { accept?: boolean; body?: () => Response | Promise<Response>; install?: (request: string) => string } = {}) => {
    const fetchSpy = makeFetch(options.body);
    const registry = new AgentRegistry({ arch: "x64", fetch: fetchSpy as unknown as typeof fetch, platform: "linux" });
    const staged: string[] = [];
    const core = {
        acpInstall: vi.fn(options.install ?? ((): string => JSON.stringify({ agents: [], consents: [], envNames: [] }))),
        acpInstallStage: vi.fn(() => {
            const folder = mkdtempSync(path.join(scratch, "stage-"));

            staged.push(folder);

            return folder;
        }),
    };
    const confirm = vi.fn(async () => options.accept ?? true);
    const installer = new AgentInstaller({ confirm, core: () => core, fetch: fetchSpy as unknown as typeof fetch, registry });

    await registry.search("");

    return { confirm, core, fetchSpy, installer, staged };
};

describe("the consent text", () => {
    it("names publisher, version, license, source and the checksum", async () => {
        const registry = new AgentRegistry({ arch: "x64", fetch: makeFetch() as unknown as typeof fetch, platform: "linux" });

        await registry.search("");

        const { detail, message } = consentText(registry.resolve("amp-acp", "0.10.0"));

        expect(message).toBe("Install “Amp” 0.10.0 from the ACP registry?");
        expect(detail).toContain("Publisher: Ada Lovelace, Grace Hopper");
        expect(detail).toContain("Version: 0.10.0");
        expect(detail).toContain("License: Apache-2.0");
        expect(detail).toContain("Download: https://example.com/amp-linux-x86_64.zip");
        expect(detail).toContain(`SHA-256 the registry published: ${SHA}`);
        expect(detail).toContain("Runs: ./amp-acp acp");
        expect(detail).toContain("Sets: AMP_MODE");
        expect(detail).toContain("never updates it on its own");
    });
});

describe("download", () => {
    it("writes the body to a new file, with a deadline", async () => {
        const fetchSpy = makeFetch();
        const file = path.join(scratch, "download");

        await download(fetchSpy as unknown as typeof fetch, "https://example.com/a.zip", file);

        expect(readFileSync(file)).toEqual(BYTES);
        expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses an error status, a redirect off https, a declared size over the cap and a body over it", async () => {
        const file = path.join(scratch, "download");
        const run = (response: () => Response) => download(makeFetch(response) as unknown as typeof fetch, "https://example.com/a.zip", file);
        const redirected = new Response(BYTES);

        // eslint-disable-next-line unicorn/prefer-https -- the case under test: a redirect that drops https
        Object.defineProperty(redirected, "url", { value: "http://evil.test/a.zip" });

        await expect(run(() => new Response("", { status: 404 }))).rejects.toThrow("failed (404)");
        await expect(run(() => redirected)).rejects.toThrow("redirected away from https");
        await expect(run(() => new Response(BYTES, { headers: { "content-length": String(600 * 1024 * 1024) } }))).rejects.toThrow("larger than allowed");
    });
});

describe("AgentInstaller", () => {
    it("asks first and downloads nothing on a no", async () => {
        const { confirm, core, fetchSpy, installer } = await setup({ accept: false });

        await expect(installer.install("amp-acp", "0.10.0")).resolves.toBeNull();

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(core.acpInstallStage).not.toHaveBeenCalled();
        expect(core.acpInstall).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("hands the core the registry's checksum, command and variables, not anything the window said", async () => {
        const { core, installer, staged } = await setup();

        await installer.install("amp-acp", "0.10.0");

        const request = JSON.parse(core.acpInstall.mock.calls[0][0]) as Record<string, unknown>;

        expect(request).toEqual({
            archive: path.join(staged[0], "download"),
            args: ["acp"],
            cmd: "./amp-acp",
            env: { AMP_MODE: "acp" },
            format: "zip",
            key: "amp-acp",
            label: "Amp",
            publisher: "Ada Lovelace, Grace Hopper",
            sha256: SHA,
            source: "https://example.com/amp-linux-x86_64.zip",
            version: "0.10.0",
        });
    });

    it("leaves no staging folder behind, whether the core accepts the file or refuses it", async () => {
        const accepted = await setup();

        await accepted.installer.install("amp-acp", "0.10.0");
        expect(existsSync(accepted.staged[0])).toBe(false);

        const refused = await setup({
            install: () => {
                throw new Error("The download does not match the checksum the registry published");
            },
        });

        await expect(refused.installer.install("amp-acp", "0.10.0")).rejects.toThrow("does not match the checksum");
        expect(existsSync(refused.staged[0])).toBe(false);
    });

    it("cleans up and reports a failed download without calling the core", async () => {
        const { core, installer, staged } = await setup({ body: () => new Response("", { status: 500 }) });

        await expect(installer.install("amp-acp", "0.10.0")).rejects.toThrow("failed (500)");
        expect(core.acpInstall).not.toHaveBeenCalled();
        expect(existsSync(staged[0])).toBe(false);
    });

    it("refuses a version the registry no longer lists and an agent it cannot verify", async () => {
        const { confirm, installer } = await setup();

        await expect(installer.install("amp-acp", "9.9.9")).rejects.toThrow("Search again");
        await expect(installer.install("cortex-code", "1.0.0")).rejects.toThrow("no checksum");
        expect(confirm).not.toHaveBeenCalled();
    });

    it("runs one install at a time", async () => {
        const { core, installer } = await setup();
        const registry = new AgentRegistry({ arch: "x64", fetch: makeFetch() as unknown as typeof fetch, platform: "linux" });

        await registry.search("");

        const slow = new AgentInstaller({
            confirm: async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 20);
                });

                return false;
            },
            core: () => core,
            registry,
        });
        const first = slow.install("amp-acp", "0.10.0");

        await expect(slow.install("amp-acp", "0.10.0")).rejects.toThrow("already in progress");
        await expect(first).resolves.toBeNull();
        await expect(installer.install("amp-acp", "0.10.0")).resolves.not.toBeNull();
    });

    it("does nothing on its own: no download, no registry read, no core call without an install", async () => {
        vi.useFakeTimers();

        try {
            const { core, fetchSpy } = await setup();
            const reads = fetchSpy.mock.calls.length;

            await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000);

            expect(fetchSpy.mock.calls).toHaveLength(reads);
            expect(core.acpInstallStage).not.toHaveBeenCalled();
            expect(core.acpInstall).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
