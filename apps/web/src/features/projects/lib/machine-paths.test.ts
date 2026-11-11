import { describe, expect, it } from "vitest";

import type { AddProjectMachine } from "../../../../../desktop/src/add-project-machines.types";
import {
    failureText,
    folderNeedsSharing,
    hostSpecOf,
    isAbsolutePath,
    isAlreadySharedError,
    isMissingFolderError,
    joinPath,
    lastSegment,
    machineRowState,
    parentPath,
} from "./machine-paths";

const machine = (overrides: Partial<AddProjectMachine>): AddProjectMachine => {
    return {
        disabledReason: null,
        id: "dev-1",
        kind: "server",
        label: "Connected",
        name: "box",
        spec: null,
        sshAlias: "box",
        status: "connected",
        ...overrides,
    };
};

const BACKSLASH = "\\";
const windows = (rest: string): string => `C:${BACKSLASH}${rest}`;

describe("parentPath", () => {
    it.each([
        ["/home/me/app", "/home/me"],
        ["/home/me/app/", "/home/me"],
        ["/home", "/"],
        ["/", null],
        ["", null],
        [windows(String.raw`Users\me`), windows("Users")],
        [windows("Users"), windows("")],
        [windows(""), null],
    ])("%s -> %s", (input, expected) => {
        expect(parentPath(input)).toBe(expected);
    });
});

describe("lastSegment", () => {
    it.each([
        ["/home/me/app", "app"],
        ["/home/me/app/", "app"],
        [windows(String.raw`Users\me`), "me"],
        ["/", ""],
    ])("%s -> %s", (input, expected) => {
        expect(lastSegment(input)).toBe(expected);
    });
});

describe("joinPath and isAbsolutePath", () => {
    it("joins under a root and under a folder", () => {
        expect(joinPath("/", "a")).toBe("/a");
        expect(joinPath("/a/", "b")).toBe("/a/b");
        expect(joinPath(windows("a"), "b")).toBe(windows(String.raw`a\b`));
    });

    it("accepts only absolute paths without NUL", () => {
        expect(isAbsolutePath("/a")).toBe(true);
        expect(isAbsolutePath(windows("a"))).toBe(true);
        expect(isAbsolutePath("a/b")).toBe(false);
        expect(isAbsolutePath("/a\0b")).toBe(false);
    });
});

describe("machineRowState", () => {
    it("disables a row with a reason", () => {
        expect(machineRowState(machine({ disabledReason: "Not paired", id: null, status: "unpaired" }))).toEqual({ kind: "disabled", reason: "Not paired" });
    });

    it("connects an ssh host that is not connected yet", () => {
        expect(machineRowState(machine({ id: null, status: "not-connected" }))).toEqual({ kind: "needs-connect", sshAlias: "box" });
    });

    it("pairs an ssh host that this computer has not paired yet, with the spec it needs", () => {
        const spec = { address: "box.example.com", identityFile: null, name: "box", port: 22, user: "me" };

        expect(machineRowState(machine({ id: null, spec, status: "unpaired" }))).toEqual({ kind: "needs-pair", spec, sshAlias: "box" });
    });

    it("gives the shell a spec without a key file when the config names none", () => {
        const spec = { address: "box.example.com", identityFile: null, name: "box", port: 2222, user: "me" };

        expect(hostSpecOf(spec)).toEqual({ address: "box.example.com", name: "box", port: 2222, user: "me" });
        expect(hostSpecOf({ ...spec, identityFile: "/k/id" })).toEqual({
            address: "box.example.com",
            identityFile: "/k/id",
            name: "box",
            port: 2222,
            user: "me",
        });
    });

    it("picks a connected server and this computer directly", () => {
        expect(machineRowState(machine({}))).toEqual({ kind: "ready", machineId: "dev-1" });
        expect(machineRowState(machine({ kind: "this-computer", sshAlias: null, status: "this-computer" }))).toEqual({ kind: "ready", machineId: "dev-1" });
    });
});

describe("folderNeedsSharing", () => {
    it("is true for a server and false for this computer", () => {
        expect(folderNeedsSharing({ kind: "server" })).toBe(true);
        expect(folderNeedsSharing({ kind: "this-computer" })).toBe(false);
    });
});

describe("desktop failures", () => {
    it("recognises a missing folder and an existing share", () => {
        expect(isMissingFolderError(new Error("device: that folder was not found"))).toBe(true);
        expect(isMissingFolderError(new Error("device: that folder cannot be read"))).toBe(false);
        expect(isAlreadySharedError(new Error("device: that folder is already shared"))).toBe(true);
        expect(isAlreadySharedError(new Error("device: the person declined"))).toBe(false);
    });

    it("strips the prefixes the bridge adds", () => {
        expect(failureText(new Error("Error invoking remote method 'x': Error: device: the person declined"))).toBe("the person declined");
    });
});
