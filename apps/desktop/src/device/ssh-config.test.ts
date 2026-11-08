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

    it("does not give a Match block's keys to the Host above it", () => {
        const [host] = parse("Host a\n  HostName a.example.com\nMatch host zzz\n  User other\n  Port 99\n");

        expect(host).toMatchObject({ port: null, user: null });
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
