import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { PortsSystem } from "./ports";
import { PortsService } from "./ports";
import type { Listener, ProcessInfo } from "./process-table";
import { descendantsOf, parseLsof, parsePs, parseSs } from "./process-table";
import { firstExisting, portsSupported, realPortsSystem } from "./system";

const row = (pid: number, ppid: number, name = "proc", startedAt = "Mon Nov 3 10:00:00 2026"): ProcessInfo => {
    return { name, pid, ppid, startedAt };
};

// 1 (app) -> 10 (agent) -> 20 (shell) -> 30 (server, :3000) -> 31 (its worker)
//                       -> 40 (another server, :4000)
// 50 (unrelated server, :5000, outside the agent) and 11 (another agent's child)
const TABLE = [
    row(1, 0, "app"),
    row(10, 1, "agent"),
    row(20, 10, "sh"),
    row(30, 20, "node"),
    row(31, 30, "worker"),
    row(40, 10, "vite"),
    row(50, 1, "other"),
    row(60, 50, "x"),
];
const LISTENING: Listener[] = [
    { address: "127.0.0.1", pid: 30, port: 3000 },
    { address: "*", pid: 40, port: 4000 },
    { address: "*", pid: 50, port: 5000 },
];

class FakeSystem implements PortsSystem {
    public readonly signals: [number, string][] = [];

    public table: ProcessInfo[] = [...TABLE];

    /** Pids that ignore SIGTERM. */
    public stubborn = new Set<number>();

    public kill(pid: number, signal: "SIGKILL" | "SIGTERM"): void {
        this.signals.push([pid, signal]);

        if (signal === "SIGKILL" || !this.stubborn.has(pid)) {
            this.table = this.table.filter((entry) => entry.pid !== pid);
        }
    }

    public async listeners(pids: number[]): Promise<Listener[]> {
        const alive = new Set(this.table.map((entry) => entry.pid));

        return LISTENING.filter((listener) => pids.includes(listener.pid) && alive.has(listener.pid));
    }

    public async processes(): Promise<ProcessInfo[]> {
        return this.table;
    }

    // eslint-disable-next-line class-methods-use-this -- the fake waits for nothing
    public async sleep(): Promise<void> {}
}

describe("reading the process table", () => {
    it("parses ps rows and keeps only the command's base name", () => {
        const rows = parsePs(
            "  123     1 Mon Nov  3 10:00:00 2026 /usr/local/bin/node\n  124   123 Tue Nov 10 09:01:02 2026 /Applications/My App/Helper\nnot a row\n",
        );

        expect(rows).toEqual([
            { name: "node", pid: 123, ppid: 1, startedAt: "Mon Nov 3 10:00:00 2026" },
            { name: "Helper", pid: 124, ppid: 123, startedAt: "Tue Nov 10 09:01:02 2026" },
        ]);
    });

    it("cuts a long command name", () => {
        expect(parsePs(`1 0 Mon Nov  3 10:00:00 2026 /bin/${"a".repeat(100)}`)[0]?.name).toHaveLength(40);
    });

    it("parses lsof field output, IPv4 and IPv6", () => {
        expect(parseLsof("p12\nn*:3000\nn[::1]:3001\np13\nn127.0.0.1:8080\nnbogus\n")).toEqual([
            { address: "*", pid: 12, port: 3000 },
            { address: "::1", pid: 12, port: 3001 },
            { address: "127.0.0.1", pid: 13, port: 8080 },
        ]);
    });

    it("parses ss output", () => {
        expect(parseSs("LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=77,fd=19))\nLISTEN 0 4096 [::]:22 [::]:*\n")).toEqual([
            { address: "127.0.0.1", pid: 77, port: 3000 },
        ]);
    });

    it("finds only the descendants of a process, never the process", () => {
        expect(
            descendantsOf(TABLE, 10)
                .map((entry) => entry.pid)
                .toSorted((a, b) => a - b),
        ).toEqual([20, 30, 31, 40]);
        expect(descendantsOf(TABLE, 999)).toEqual([]);
    });

    it("survives a cycle in the table", () => {
        expect(descendantsOf([row(1, 2), row(2, 1)], 1).map((entry) => entry.pid)).toEqual([2]);
    });
});

describe("listing ports", () => {
    it("lists what the agent's tree listens on and nothing outside it", async () => {
        const ports = await new PortsService(new FakeSystem(), 1).list(10);

        expect(ports.map((port) => [port.port, port.pid, port.name])).toEqual([
            [3000, 30, "node"],
            [4000, 40, "vite"],
        ]);
    });

    it("lists nothing for a session with no process of its own", async () => {
        expect(await new PortsService(new FakeSystem(), 1).list(undefined)).toEqual([]);
    });
});

describe("stopping a server", () => {
    it("ends the listener and its own descendants, and nothing else", async () => {
        const system = new FakeSystem();

        expect(await new PortsService(system, 1).stop(10, { pid: 30, startedAt: "Mon Nov 3 10:00:00 2026" })).toBe(true);
        expect(system.signals.map(([pid]) => pid).toSorted((a, b) => a - b)).toEqual([30, 31]);
        expect(system.table.map((entry) => entry.pid)).toEqual([1, 10, 20, 40, 50, 60]);
    });

    it("never targets the agent, the app or a process outside the agent's tree", async () => {
        const service = new PortsService(new FakeSystem(), 1);
        const started = "Mon Nov 3 10:00:00 2026";

        // The agent itself, the app, an unrelated server, and a process that is below the agent but listens on nothing.
        await Promise.all([10, 1, 50, 20].map(async (pid) => await expect(service.stop(10, { pid, startedAt: started })).rejects.toThrow()));

        expect(await new FakeSystem().processes()).toHaveLength(TABLE.length);
    });

    it("sends no signal at all when it refuses", async () => {
        const system = new FakeSystem();

        await expect(new PortsService(system, 1).stop(10, { pid: 50, startedAt: "Mon Nov 3 10:00:00 2026" })).rejects.toThrow("no longer running");
        await expect(new PortsService(system, 1).stop(undefined, { pid: 30, startedAt: "Mon Nov 3 10:00:00 2026" })).rejects.toThrow();
        expect(system.signals).toEqual([]);
    });

    it("refuses a pid whose start time changed, as a reused pid would", async () => {
        const system = new FakeSystem();

        await expect(new PortsService(system, 1).stop(10, { pid: 30, startedAt: "Mon Nov 3 11:11:11 2026" })).rejects.toThrow("no longer running");
        expect(system.signals).toEqual([]);
    });

    it("kills what ignores SIGTERM after the grace period, and still never the agent", async () => {
        const system = new FakeSystem();

        system.stubborn.add(30);

        expect(await new PortsService(system, 1, 300).stop(10, { pid: 30, startedAt: "Mon Nov 3 10:00:00 2026" })).toBe(true);
        expect(system.signals).toContainEqual([30, "SIGKILL"]);
        expect(system.signals.some(([pid]) => pid === 10 || pid === 1)).toBe(false);
    });

    it("does not kill a pid that now belongs to another process", async () => {
        const system = new FakeSystem();

        system.stubborn.add(30);

        const service = new PortsService(system, 1, 300);
        // After the TERM, the stubborn server dies elsewhere and its pid is taken by a new process.
        const original = system.sleep.bind(system);

        system.sleep = async () => {
            system.table = system.table.map((entry) => entry.pid === 30 ? { ...entry, startedAt: "Mon Nov 3 12:00:00 2026" } : entry);
            await original();
        };

        await service.stop(10, { pid: 30, startedAt: "Mon Nov 3 10:00:00 2026" });
        expect(system.signals).not.toContainEqual([30, "SIGKILL"]);
    });
});

const hasProcessTable = firstExisting(["/bin/ps", "/usr/bin/ps"]) !== undefined;
const hasListingTool = firstExisting(["/usr/sbin/lsof", "/usr/bin/lsof", "/usr/bin/ss", "/usr/sbin/ss", "/bin/ss"]) !== undefined;
const toolsMissing = !portsSupported || !hasProcessTable || !hasListingTool;

const SERVER = "require('net').createServer().listen(0,'127.0.0.1',function(){console.log('PORT '+this.address().port)})";
// An agent stand-in that starts a server and a plain sleeper in ITS OWN process group, as a real agent's tools are.
const AGENT = `const{spawn}=require('child_process');const s=spawn(process.execPath,['-e',${JSON.stringify(SERVER)}],{stdio:['ignore','pipe','inherit']});s.stdout.on('data',d=>process.stdout.write(d));const q=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('SLEEPER '+q.pid);console.log('SERVER '+s.pid);setInterval(()=>{},1000)`;

describe.skipIf(toolsMissing)(toolsMissing ? "real processes (SKIPPED: needs macOS or Linux with ps and lsof or ss)" : "real processes", () => {
    let agent: ChildProcess | undefined;
    const spawned: number[] = [];

    afterEach(() => {
        const pids = [...spawned];

        spawned.length = 0;

        for (const pid of pids) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Already gone.
            }
        }

        agent?.kill("SIGKILL");
    });

    const alive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);

            return true;
        } catch {
            return false;
        }
    };

    it("lists a server started under the agent and Stop ends it alone", async () => {
        agent = spawn(process.execPath, ["-e", AGENT], { stdio: ["ignore", "pipe", "inherit"] });

        const agentPid = agent.pid as number;
        const seen: Record<string, number> = {};
        const lines = await new Promise<string>((resolve) => {
            let buffer = "";

            agent?.stdout?.on("data", (chunk: Buffer) => {
                buffer += chunk.toString();

                if (buffer.includes("PORT ") && buffer.includes("SLEEPER ") && buffer.includes("SERVER ")) {
                    resolve(buffer);
                }
            });
        });

        for (const line of lines.split("\n")) {
            const [key, value] = line.split(" ", 2);

            if (key !== undefined && value !== undefined) {
                seen[key] = Number(value);
            }
        }

        spawned.push(seen.SERVER as number, seen.SLEEPER as number);

        const service = new PortsService(realPortsSystem);
        const ports = await service.list(agentPid);

        expect(ports.map((port) => [port.pid, port.port, port.address])).toEqual([[seen.SERVER, seen.PORT, "127.0.0.1"]]);

        expect(await service.stop(agentPid, { pid: ports[0]?.pid as number, startedAt: ports[0]?.startedAt as string })).toBe(true);
        expect(alive(seen.SERVER as number)).toBe(false);
        // The agent shares its group with the server and was not touched, nor was its other child.
        expect(alive(agentPid)).toBe(true);
        expect(alive(seen.SLEEPER as number)).toBe(true);
        expect(await service.list(agentPid)).toEqual([]);
    }, 20_000);
});
