import { describe, expect, it } from "vitest";

import { parseSshConfig, readSshConfig } from "./ssh-config";

const HOME = "/home/me";
const parse = (text: string) => parseSshConfig(text, HOME);

describe("parseSshConfig", () => {
    it("skips Host patterns with a wildcard", () => {
        const hosts = parse("Host *\n  User root\nHost build-*\nHost !bad\nHost a?\nHost box\n  HostName box.example.com\n");

        expect(hosts.map((host) => host.alias)).toEqual(["box"]);
    });

    it("gives one host per alias of a Host line", () => {
        const hosts = parse("Host one two\n  HostName shared.example.com\n  User deploy\n  Port 2222\n");

        expect(hosts.map((host) => [host.alias, host.hostName, host.user, host.port])).toEqual([
            ["one", "shared.example.com", "deploy", 2222],
            ["two", "shared.example.com", "deploy", 2222],
        ]);
    });

    it("lists an alias once when a Host line repeats it", () => {
        const hosts = parse("Host box box\n  HostName box.example.com\n");

        expect(hosts.map((host) => host.alias)).toEqual(["box"]);
    });

    it("reads keys in any case, with = or quotes, and takes the first value of a key", () => {
        const [host] = parse("host box\n  hostname=a.example.com\n  HostName b.example.com\n  IdentityFile \"/k/one\"\n  IdentityFile /k/two\n");

        expect(host).toMatchObject({ hostName: "a.example.com", identityFile: "/k/one" });
    });

    it("expands a leading ~ in IdentityFile", () => {
        const [host] = parse("Host box\n  IdentityFile ~/.ssh/id_box\n");

        expect(host?.identityFile).toBe("/home/me/.ssh/id_box");
    });

    it("ignores comments and an invalid port", () => {
        const [host] = parse("# Host nope\nHost box\n  Port 99999\n");

        expect(host).toMatchObject({ alias: "box", port: null });
    });

    it("disables a host that uses Include, ProxyJump or ProxyCommand, with a reason", () => {
        const hosts = parse("Host a\n  ProxyJump bastion\nHost b\n  Include extra\nHost c\n  ProxyCommand nc %h %p\nHost d\n  HostName d.example.com\n");

        expect(hosts.map((host) => [host.alias, host.disabledReason === null])).toEqual([
            ["a", false],
            ["b", false],
            ["c", false],
            ["d", true],
        ]);
        expect(hosts[0]?.disabledReason).toContain("ProxyJump");
    });

    it("disables a host a Match rule names, and every host for a Match it cannot evaluate", () => {
        const named = parse("Match host a\n  User x\nHost a\nHost b\n");

        expect(named.map((host) => host.disabledReason === null)).toEqual([false, true]);
        expect(named[0]?.disabledReason).toContain("Match");

        const exec = parse("Host a\nHost b\nMatch exec \"true\"\n  User x\n");

        expect(exec.every((host) => host.disabledReason !== null)).toBe(true);
    });

    it("applies a global setting before the first Host line", () => {
        const [host] = parse("User ops\nHost box\n  HostName box.example.com\n");

        expect(host).toMatchObject({ alias: "box", user: "ops" });
    });

    it("takes a setting the alias block lacks from a later wildcard block", () => {
        const [host] = parse("Host box\n  HostName box.example.com\nHost *.example.com box\n  Port 2022\n");

        expect(host).toMatchObject({ alias: "box", port: 2022 });
    });

    it("takes the first value across blocks in file order", () => {
        const [host] = parse("Host box\n  Port 2200\nHost b*\n  Port 2300\n  User late\nHost *\n  User later\n");

        expect(host).toMatchObject({ port: 2200, user: "late" });
    });

    it("excludes a block whose negated pattern matches", () => {
        const hosts = parse("Host * !box\n  User skipped\nHost box other\n  Port 2200\n");

        expect(hosts.map((host) => [host.alias, host.user, host.port])).toEqual([
            ["box", null, 2200],
            ["other", "skipped", 2200],
        ]);
    });

    it("disables a host when a wildcard block that applies uses an unsupported key", () => {
        const hosts = parse("Host box\n  HostName box.example.com\nHost *.internal\n  ProxyJump bastion\nHost plain.internal other\n");

        expect(hosts.map((host) => [host.alias, host.disabledReason === null])).toEqual([
            ["box", true],
            ["plain.internal", false],
            ["other", true],
        ]);
        expect(hosts[1]?.disabledReason).toContain("ProxyJump");
    });

    it("does not give a Match block's keys to the Host above it", () => {
        const [host] = parse("Host a\n  HostName a.example.com\nMatch host zzz\n  User other\n  Port 99\n");

        expect(host).toMatchObject({ port: null, user: null });
    });

    it("keeps a host enabled for an Include before the first Host line, and disables one for an Include inside its block", () => {
        const [global] = parse("Include other\nHost a\n  HostName a.example.com\n");

        expect(global).toMatchObject({ alias: "a", disabledReason: null });

        const [inside] = parse("Host a\n  Include other\n");

        expect(inside?.disabledReason).toContain("Include");
    });

    it("disables every host for a ProxyJump or ProxyCommand before the first Host line", () => {
        const hosts = parse("ProxyJump bastion\nHost a\nHost b\n");

        expect(hosts.map((host) => host.disabledReason !== null)).toEqual([true, true]);
    });

    it("accepts a decimal Port from 1 to 65535 only, and disables a host with any other value", () => {
        const hosts = parse("Host hex\n  Port 0x10\nHost word\n  Port abc\nHost big\n  Port 99999\nHost zero\n  Port 0\nHost ok\n  Port 2222\nHost none\n");

        expect(hosts.map((host) => [host.alias, host.port, host.disabledReason !== null])).toEqual([
            ["hex", null, true],
            ["word", null, true],
            ["big", null, true],
            ["zero", null, true],
            ["ok", 2222, false],
            ["none", null, false],
        ]);
    });

    it("does not fall back to a later Port when the first one is invalid", () => {
        const [host] = parse("Host a\n  Port abc\nHost *\n  Port 2200\n");

        expect(host).toMatchObject({ port: null });
        expect(host?.disabledReason).toContain("Port");
    });

    it("ignores an inline comment on a Host line, and keeps a # inside quotes", () => {
        expect(parse("Host build # production\n").map((host) => host.alias)).toEqual(["build"]);
        expect(parse('Host "a #b" c\n').map((host) => host.alias)).toEqual(["a #b", "c"]);
        expect(parse("Host 😀 # production\n").map((host) => host.alias)).toEqual(["😀"]);
    });

    it("disables the hosts a Match rule it cannot evaluate could apply to", () => {
        for (const rule of ["host *", "user deploy", "originalhost *.example.com", "host a,!b", "localuser me", "all", "canonical"]) {
            const hosts = parse(`Host a\n  HostName a.example.com\nMatch ${rule}\n  Port 2200\n`);

            expect(hosts.map((host) => host.disabledReason !== null), rule).toEqual([true]);
        }

        const [plain] = parse("Host a\n  HostName a.example.com\nMatch host other.example.com\n  Port 2200\n");

        expect(plain?.disabledReason).toBeNull();
    });

    it("disables a host whose HostName or IdentityFile holds an ssh token it cannot expand", () => {
        expect(parse("Host a\n  HostName %h.example.com\n").map((host) => host.disabledReason !== null)).toEqual([true]);
        expect(parse("Host a\n  HostName a.example.com\n  IdentityFile ~/.ssh/%r\n").map((host) => host.disabledReason !== null)).toEqual([true]);
        expect(parse("Host a\n  HostName a.example.com\n  IdentityFile ~/.ssh/id\n").map((host) => host.disabledReason !== null)).toEqual([false]);
    });

    it("compares Match host and Match originalhost names without regard to case", () => {
        const byHostName = parse("Host a\n  HostName a.example.com\nMatch host A.EXAMPLE.COM\n  Port 2200\n");
        const byAlias = parse("Host a\n  HostName a.example.com\nMatch originalhost A\n  Port 2200\n");

        expect(byHostName.map((host) => host.disabledReason !== null)).toEqual([true]);
        expect(byAlias.map((host) => host.disabledReason !== null)).toEqual([true]);
    });

    it("applies User, IdentityFile and ProxyJump of a Host * block to named aliases, first value first", () => {
        const [first, second] = parse("Host a\n  User mine\nHost *\n  User all\n  IdentityFile /k/all\n  ProxyJump bastion\n");

        expect(first).toMatchObject({ alias: "a", identityFile: "/k/all", user: "mine" });
        expect(first?.disabledReason).toContain("ProxyJump");
        expect(second).toBeUndefined();
    });
});

describe("readSshConfig", () => {
    it("returns an empty list for a missing file without throwing", () => {
        expect(
            readSshConfig(HOME, () => {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }),
        ).toEqual([]);
    });

    it("reads ~/.ssh/config under the given home", () => {
        let asked = "";
        const hosts = readSshConfig(HOME, (file) => {
            asked = file;

            return "Host box\n";
        });

        expect(asked).toBe("/home/me/.ssh/config");
        expect(hosts).toHaveLength(1);
    });
});
