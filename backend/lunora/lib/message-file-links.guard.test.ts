/**
 * Every write of a message's `fileIds` also maintains `chatFileThreads`.
 *
 * The password-lock gate (`agent/files.ts#fileGatedByLockedChat`) finds a locked
 * chat's files through those links, not by reading messages. A write that sets
 * `fileIds` without its link lets a locked file through, so this walks the
 * non-test source under `lunora/` and fails when:
 *
 * - a file inserts a `messages` row, or sets `fileIds` on any write, and is not
 *   on the list below; or
 * - a listed file that writes messages or `fileIds` does not call
 *   `changeMessageFiles`, unless its entry says it writes no attachments.
 *
 * The check is per file, not per call: a file on the list has been read by hand
 * for the call that writes, and its reason says which.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const LUNORA_ROOT = path.resolve(import.meta.dirname, "..");

const WRITE_METHODS = new Set(["insert", "patch", "replace"]);
const WRITE_HELPERS = new Set(["insertMessageRow", "patchMessage", "patchRow"]);

/** Files that write messages or `fileIds`, with the reason each is covered. */
const AUDITED: Record<string, { links: boolean; reason: string }> = {
    "agent/messages.ts": {
        links: true,
        reason: "addMessagesHandler (insert and pending patch), updateMessage and cloneMessageBatch call changeMessageFiles",
    },
    "agent/table-writes.ts": { links: false, reason: "defines insertMessageRow and patchMessage; callers are audited here" },
    "chat-import/steps.ts": { links: false, reason: "imported conversations carry no attachments" },
    "messenger/functions.ts": {
        links: true,
        reason: "saveMessengerMessage and completeMessengerMessage call changeMessageFiles; the insert at 661 carries no attachments",
    },
};

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
        const full = path.join(directory, name);

        if (statSync(full).isDirectory()) {
            return name === "_generated" || name === "node_modules" ? [] : sourceFiles(full);
        }

        return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts") ? [full] : [];
    });

type Writes = { file: string; insertsMessage: boolean; setsFileIds: boolean; text: string };

const writesIn = (file: string): Writes => {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let insertsMessage = false;
    let setsFileIds = false;

    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
            const helper = ts.isIdentifier(callee) ? callee.text : undefined;

            if ((method !== undefined && WRITE_METHODS.has(method)) || (helper !== undefined && WRITE_HELPERS.has(helper))) {
                const argsText = node.arguments.map((argument) => argument.getText()).join(" ");
                const first = node.arguments[0];

                if (argsText.includes("fileIds")) {
                    setsFileIds = true;
                }

                if ((method === "insert" && first && ts.isStringLiteral(first) && first.text === "messages") || helper === "insertMessageRow") {
                    insertsMessage = true;
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    return { file: path.relative(LUNORA_ROOT, file), insertsMessage, setsFileIds, text };
};

const writers = sourceFiles(LUNORA_ROOT)
    .map((file) => writesIn(file))
    .filter((writes) => writes.insertsMessage || writes.setsFileIds);

describe("message fileIds writes", () => {
    it("every file that inserts a message or sets fileIds on a write is on the audited list", () => {
        expect(writers.map((writes) => writes.file).filter((file) => !(file in AUDITED))).toStrictEqual([]);
    });

    it("every audited file that writes messages or fileIds calls changeMessageFiles, unless it carries no attachments", () => {
        const unlinked = writers
            .filter((writes) => AUDITED[writes.file]?.links)
            .filter((writes) => !writes.text.includes("changeMessageFiles"))
            .map((writes) => writes.file);

        expect(unlinked).toStrictEqual([]);
    });

    it("the audited list names only files that still write (a stale entry would hide a moved write)", () => {
        const current = new Set(writers.map((writes) => writes.file));

        expect(Object.keys(AUDITED).filter((file) => !current.has(file))).toStrictEqual([]);
    });
});
