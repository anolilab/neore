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

// 1 (app) -> 10 (agent, :2000) -> 20 (shell) -> 30 (server, :3000) -> 31 (its worker)
//                       -> 40 (another server, :4000)
// 50 (unrelated server, :5000, outside the agent) and 60 (its child)
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
    { address: "127.0.0.1", pid: 10, port: 2000 },
    { address: "127.0.0.1", pid: 30, port: 3000 },
    { address: "*", pid: 40, port: 4000 },
    { address: "*", pid: 50, port: 5000 },
];

class FakeSystem implements PortsSystem {
    public table: ProcessInfo[] = [...TABLE];

    public async listeners(pids: number[]): Promise<Listener[]> {
        const alive = new Set(this.table.map((entry) => entry.pid));

        return LISTENING.filter((listener) => pids.includes(listener.pid) && alive.has(listener.pid));
    }

    public async processes(): Promise<ProcessInfo[]> {
        return this.table;
    }
}

describe("reading the process table", () => {
    it("parses ps rows and keeps only the command's base name", () => {
        const rows = parsePs(
            "  123     1 Ss Mon Nov  3 10:00:00 2026 /usr/local/bin/node\n  124   123 Ss Tue Nov 10 09:01:02 2026 /Applications/My App/Helper\nnot a row\n",
        );

        expect(rows).toEqual([
            { name: "node", pid: 123, ppid: 1, startedAt: "Mon Nov 3 10:00:00 2026" },
            { name: "Helper", pid: 124, ppid: 123, startedAt: "Tue Nov 10 09:01:02 2026" },
        ]);
    });

    it("cuts a long command name", () => {
        expect(parsePs(`1 0 Ss Mon Nov  3 10:00:00 2026 /bin/${"a".repeat(100)}`)[0]?.name).toHaveLength(40);
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

    it("reads owners only from the users column, never a pid= inside a process name", () => {
        expect(parseSs("LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"pid=30,fd=1\",pid=77,fd=19))\n")).toEqual([
            { address: "127.0.0.1", pid: 77, port: 3000 },
        ]);
        expect(parseSs("LISTEN 0 511 *:80 *:* users:((\"nginx\",pid=5,fd=6),(\"nginx\",pid=6,fd=6))\n").map((entry) => entry.pid)).toEqual([5, 6]);
        // A quote in a name could make another pid look like the owner, so the row is dropped instead.
        expect(parseSs('LISTEN 0 511 *:80 *:* users:(("",pid=3,fd=1),(",pid=77,fd=19))\n')).toEqual([]);
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
    it("lists what the agent and its tree listen on and nothing outside it", async () => {
        const ports = await new PortsService(new FakeSystem()).list(10);

        expect(ports.map((port) => [port.port, port.pid, port.name])).toEqual([
            [2000, 10, "agent"],
            [3000, 30, "node"],
            [4000, 40, "vite"],
        ]);
    });

    it("lists nothing for a session with no process of its own", async () => {
        expect(await new PortsService(new FakeSystem()).list(undefined)).toEqual([]);
    });

    it("drops a socket whose process left the agent's tree while it was read", async () => {
        const system = new FakeSystem();
        const processes = system.processes.bind(system);
        let reads = 0;

        // After the listener query, the server (30) has been re-parented to pid 1, out of the agent's tree.
        system.processes = async () => {
            reads += 1;

            const table = await processes();

            return table.map((entry) => (reads > 1 && entry.pid === 30 ? { ...entry, ppid: 1 } : entry));
        };

        const views = await new PortsService(system).list(10);

        expect(views.map((view) => view.pid)).toEqual([10, 40]);
    });

    it("drops a socket whose pid now belongs to another process", async () => {
        const system = new FakeSystem();
        const processes = system.processes.bind(system);
        let reads = 0;

        // After the listener query, pid 30 is a different process (another start time).
        system.processes = async () => {
            reads += 1;

            const table = await processes();

            return table.map((entry) => reads > 1 && entry.pid === 30 ? { ...entry, startedAt: "Mon Nov 3 11:11:11 2026" } : entry);
        };

        const views = await new PortsService(system).list(10);

        expect(views.map((view) => view.pid)).toEqual([10, 40]);
    });
});

const hasProcessTable = firstExisting(["/bin/ps", "/usr/bin/ps"]) !== undefined;
const hasListingTool = firstExisting(["/usr/sbin/lsof", "/usr/bin/lsof", "/usr/bin/ss", "/usr/sbin/ss", "/bin/ss"]) !== undefined;
const toolsMissing = !portsSupported || !hasProcessTable || !hasListingTool;

const SERVER = "require('net').createServer().listen(0,'127.0.0.1',function(){console.log('PORT '+this.address().port)})";
// An agent stand-in that starts a server as its child, as a real agent's tools do.
const AGENT = `const{spawn}=require('child_process');const s=spawn(process.execPath,['-e',${JSON.stringify(SERVER)}],{stdio:['ignore','pipe','inherit']});s.stdout.on('data',d=>process.stdout.write(d));console.log('SERVER '+s.pid);setInterval(()=>{},1000)`;

describe.skipIf(toolsMissing)(toolsMissing ? "real processes (SKIPPED: needs macOS or Linux with ps and lsof or ss)" : "real processes", () => {
    let agent: ChildProcess | undefined;
    let server: number | undefined;

    afterEach(() => {
        try {
            if (server !== undefined) {
                process.kill(server, "SIGKILL");
            }
        } catch {
            // Already gone.
        }

        // The agent leads its own process group, so the server under it goes too, even if the test failed before naming it.
        if (agent?.pid !== undefined) {
            try {
                process.kill(-agent.pid, "SIGKILL");
            } catch {
                // Already gone.
            }
        }
    });

    it("lists a server started under the agent", async () => {
        agent = spawn(process.execPath, ["-e", AGENT], { detached: true, stdio: ["ignore", "pipe", "inherit"] });

        const agentPid = agent.pid as number;
        const seen: Record<string, number> = {};
        const lines = await new Promise<string>((resolve, reject) => {
            let buffer = "";

            agent?.stdout?.on("data", (chunk: Buffer) => {
                buffer += chunk.toString();

                if (buffer.includes("PORT ") && buffer.includes("SERVER ")) {
                    resolve(buffer);
                }
            });
            // A stand-in that fails to start ends the test at once instead of leaving it waiting.
            agent?.once("error", reject);
            agent?.once("exit", (code) => {
                reject(new Error(`the agent stand-in exited (${String(code)}) before its server listened`));
            });
        });

        for (const line of lines.split("\n")) {
            const [key, value] = line.split(" ", 2);

            if (key !== undefined && value !== undefined) {
                seen[key] = Number(value);
            }
        }

        server = seen.SERVER;

        const ports = await new PortsService(realPortsSystem).list(agentPid);

        expect(ports.map((port) => [port.pid, port.port, port.address])).toEqual([[seen.SERVER, seen.PORT, "127.0.0.1"]]);
    });
});
