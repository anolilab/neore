import { describe, expect, it, vi } from "vitest";

import { REGISTRY_FIXTURE, SHA } from "./fixtures/registry";
import { AgentRegistry, archiveFormat, parseRegistry, platformKey, REGISTRY_URL, resolveInstall } from "./registry";

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => Response.json(body, { headers: { "content-type": "application/json" }, ...init });

describe("registry format", () => {
    it("keeps the entries that match the schema and drops the rest", () => {
        expect(parseRegistry(REGISTRY_FIXTURE).map((agent) => agent.id)).toEqual(["amp-acp", "cortex-code", "thing"]);
    });

    it("names the publisher from authors, else from the repository owner, else says it is unknown", () => {
        const [amp, cortex, thing] = parseRegistry(REGISTRY_FIXTURE);

        expect(amp.publisher).toBe("Ada Lovelace, Grace Hopper");
        expect(cortex.publisher).toBe("snowflake");
        expect(thing.publisher).toBe("unknown publisher");
    });

    it("refuses a file that is not a registry", () => {
        // Two entries that share an id cannot be told apart at install time, so neither is offered.
        const twin = { description: "x", distribution: { binary: {} }, id: "twin", license: "MIT", name: "Twin", version: "1.0.0" };

        expect(parseRegistry({ agents: [twin, { ...twin, name: "Twin again" }, { ...twin, id: "solo" }] }).map((agent) => agent.id)).toEqual(["solo"]);
        expect(() => parseRegistry({ agents: "no" })).toThrow("format Neore does not know");
        expect(() => parseRegistry(null)).toThrow("format Neore does not know");
    });

    it("maps this machine to the registry's platform keys", () => {
        expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
        expect(platformKey("linux", "x64")).toBe("linux-x86_64");
        expect(platformKey("win32", "x64")).toBe("windows-x86_64");
        expect(platformKey("freebsd", "x64")).toBeUndefined();
        expect(platformKey("linux", "ia32")).toBeUndefined();
    });

    it("tells the download formats apart by the URL path", () => {
        expect(archiveFormat("https://x.test/a.tar.gz?token=1")).toBe("tar.gz");
        expect(archiveFormat("https://x.test/a.TGZ")).toBe("tar.gz");
        expect(archiveFormat("https://x.test/a.zip")).toBe("zip");
        expect(archiveFormat("https://x.test/agent-linux")).toBe("raw");
        expect(archiveFormat("https://x.test/a%2Ezip")).toBe("zip");
        expect(archiveFormat("https://x.test/a%2Etar%2Egz")).toBe("tar.gz");
        expect(archiveFormat("https://x.test/a.tar.bz2")).toBeUndefined();
        expect(archiveFormat("https://x.test/a.dmg")).toBeUndefined();
    });
});

describe("what can be installed", () => {
    const [amp, cortex, thing] = parseRegistry(REGISTRY_FIXTURE);

    it("needs a binary for this platform with a published checksum over https", () => {
        const resolved = resolveInstall(amp, "linux-x86_64");

        expect(resolved).toMatchObject({ format: "zip", sha256: SHA });
        expect(resolveInstall(amp, "darwin-aarch64")).toMatchObject({ format: "tar.gz", sha256: SHA });
        expect(resolveInstall(amp, "windows-aarch64")).toMatch("No download for this platform");
        expect(resolveInstall(cortex, "darwin-aarch64")).toMatch("no checksum");
        expect(resolveInstall(thing, "darwin-aarch64")).toMatch("npx or uvx");
        expect(resolveInstall(amp, "windows-x86_64")).toMatch("cannot unpack");
        expect(resolveInstall(amp, undefined)).toMatch("not supported");
    });

    it("lists an entry the core would refuse as not installable, with the reason", () => {
        const target = amp.binary["linux-x86_64"];
        const variant = (change: Partial<typeof target>, agent: Partial<typeof amp> = {}) => resolveInstall({ ...amp, ...agent, binary: { "linux-x86_64": { ...target, ...change } } }, "linux-x86_64");

        expect(variant({})).toMatchObject({ format: "zip" });
        expect(variant({}, { version: "latest" })).toMatch("plain version number");
        expect(variant({}, { version: "1..2" })).toMatch("plain version number");
        expect(variant({}, { publisher: "x".repeat(201) })).toMatch("publisher");
        expect(variant({ args: [..."a".repeat(51)] })).toMatch("arguments");
        expect(variant({ args: ["x".repeat(1001)] })).toMatch("arguments");
        expect(variant({ cmd: "../agent" })).toMatch("inside the download");
        expect(variant({ cmd: "/bin/sh" })).toMatch("inside the download");
        expect(variant({ cmd: String.raw`C:\agent.exe` })).toMatch("inside the download");
        expect(variant({ archive: `https://example.com/${"a".repeat(1000)}.zip` })).toMatch("too long");

        for (const name of ["NODE_OPTIONS", "path", "NEORE_X", "ld_preload", "1BAD", "has space"]) {
            expect(variant({ env: { [name]: "x" } }), name).toMatch(`It sets ${name}`);
        }

        expect(variant({ env: { DEMO_MODE: "x".repeat(8 * 1024 + 1) } })).toMatch("It sets DEMO_MODE");
        expect(variant({ env: { DEMO_MODE: "acp" } })).toMatchObject({ format: "zip" });

        const raw = { archive: "https://example.com/tool", cmd: "bin/tool" };

        expect(variant(raw)).toMatch("inside the download");
        expect(variant({ ...raw, cmd: "./tool" })).toMatchObject({ format: "raw" });
    });

    it("refuses a download that is not https", () => {
        const plain = { ...amp, binary: { "linux-x86_64": { ...amp.binary["linux-x86_64"], archive: "http://example.com/a.zip" } } }; // eslint-disable-line unicorn/prefer-https -- the case under test

        expect(resolveInstall(plain, "linux-x86_64")).toMatch("not served over https");
    });
});

describe("AgentRegistry", () => {
    const registryWith = (respond: () => Response | Promise<Response>, now = () => 0) => {
        const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());

        return { fetchSpy, registry: new AgentRegistry({ arch: "x64", fetch: fetchSpy as unknown as typeof fetch, now, platform: "linux" }) };
    };

    it("reads the official registry with a deadline and lists what this machine can install", async () => {
        const { fetchSpy, registry } = registryWith(() => jsonResponse(REGISTRY_FIXTURE));
        const listings = await registry.search("");

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe(REGISTRY_URL);
        expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
        expect(listings.map(({ id, installable }) => [id, installable])).toEqual([["amp-acp", true], ["cortex-code", false], ["thing", false]]);
        expect(listings[0]).toMatchObject({ license: "Apache-2.0", publisher: "Ada Lovelace, Grace Hopper", version: "0.10.0" });
        expect(listings[1].reason).toMatch("no checksum");
    });

    it("lists nothing as installable where coding agents cannot run", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse(REGISTRY_FIXTURE));
        const registry = new AgentRegistry({ arch: "x64", fetch: fetchSpy as unknown as typeof fetch, platform: "linux", supported: false });
        const listings = await registry.search("");

        expect(listings.some((listing) => listing.installable)).toBe(false);
        expect(listings[0].reason).toMatch("not supported");
    });

    it("answers a second search from the last answer for a minute, then reads the registry again", async () => {
        let now = 0;
        const { fetchSpy, registry } = registryWith(() => jsonResponse(REGISTRY_FIXTURE), () => now);

        await registry.search("");
        now = 59_000;
        const found = await registry.search("thing");

        expect(found.map((entry) => entry.id)).toEqual(["thing"]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        now = 61_000;
        await registry.search("");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("filters by name, id and description", async () => {
        const { registry } = registryWith(() => jsonResponse(REGISTRY_FIXTURE));

        const ids = async (query: string) => {
            const found = await registry.search(query);

            return found.map((entry) => entry.id);
        };

        expect(await ids("AMP")).toEqual(["amp-acp"]);
        expect(await ids("npx")).toEqual(["thing"]);
    });

    it("fails on an error status, a redirect off https and an answer that is too large", async () => {
        await expect(registryWith(() => new Response("", { status: 503 })).registry.search("")).rejects.toThrow("answered 503");

        const toHttp = () => new Response(null, { headers: { location: ["http", "://evil.test/registry.json"].join("") }, status: 302 });

        await expect(registryWith(toHttp).registry.search("")).rejects.toThrow("redirected away from https");
        await expect(registryWith(() => new Response("x".repeat(6 * 1024 * 1024))).registry.search("")).rejects.toThrow("larger than expected");
    });

    it("installs only what the last search listed, at the version it listed", async () => {
        let now = 0;
        const { registry } = registryWith(() => jsonResponse(REGISTRY_FIXTURE), () => now);

        expect(() => registry.resolve("amp-acp", "0.10.0")).toThrow("Search the registry again");

        await registry.search("");

        expect(registry.resolve("amp-acp", "0.10.0").sha256).toBe(SHA);
        expect(() => registry.resolve("amp-acp", "0.9.0")).toThrow("Search again");
        expect(() => registry.resolve("missing", "1.0.0")).toThrow("Search again");
        expect(() => registry.resolve("cortex-code", "1.0.0")).toThrow("no checksum");

        now = 16 * 60_000;
        expect(() => registry.resolve("amp-acp", "0.10.0")).toThrow("Search the registry again");
    });

    it("never reads the registry on its own", async () => {
        vi.useFakeTimers();

        try {
            const { fetchSpy, registry } = registryWith(() => jsonResponse(REGISTRY_FIXTURE));

            await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(() => registry.resolve("amp-acp", "0.10.0")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });
});
