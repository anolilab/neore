import { describe, expect, it } from "vitest";

import { settleUploadWait, startUploadWait } from "./upload-send-wait";

type Status = "pending" | "uploading" | "complete" | "error";

/** A draft's attachment; each file is named `<id>.txt`. */
const file = (id: string, status: Status, fileId?: string) => {
    return { fileId, id, name: `${id}.txt`, status };
};

const files = (...list: [string, Status][]) => list.map(([id, status]) => file(id, status));

const reference = (id: string) => {
    return { id };
};

/** The draft pressed on: two uploads running, "a" and "b", the text "see files" and no reference image. */
const pressed = startUploadWait({ attachments: files(["a", "uploading"], ["b", "pending"]), references: [], text: "see files" }, "thread-1");

/** What the settle step sees for the draft now, in the chat "thread-1". */
const settleNow = (attachments: ReturnType<typeof files>, text = "see files", references: ReturnType<typeof reference>[] = []) =>
    settleUploadWait(pressed, { attachments, references, text }, "thread-1");

describe("startUploadWait", () => {
    it("waits on the draft's uploads that are not complete, and remembers the draft pressed on", () => {
        const draft = { attachments: [file("a", "complete", "f1"), file("b", "uploading")], references: [reference("r1")], text: "see files" };

        expect(startUploadWait(draft, "thread-1")).toStrictEqual({
            accountId: undefined,
            attachmentIds: ["b"],
            pressedAttachments: [
                { complete: true, fileId: "f1", id: "a" },
                { complete: false, fileId: undefined, id: "b" },
            ],
            referenceIds: ["r1"],
            target: "",
            text: "see files",
            threadId: "thread-1",
        });
    });
});

describe("settleUploadWait", () => {
    it("keeps waiting while a waited upload is still running", () => {
        expect(settleNow(files(["a", "complete"], ["b", "uploading"]))).toStrictEqual({ kind: "waiting" });
        expect(settleNow(files(["a", "pending"], ["b", "complete"]))).toStrictEqual({ kind: "waiting" });
    });

    it("sends once every waited upload is complete", () => {
        expect(settleNow(files(["a", "complete"], ["b", "complete"]))).toStrictEqual({ kind: "send" });
    });

    it("stops at a failed upload and names the file", () => {
        expect(settleNow(files(["a", "complete"], ["b", "error"]))).toStrictEqual({ kind: "failed", name: "b.txt" });
    });

    it("reports a failure even while another waited upload still runs", () => {
        expect(settleNow(files(["a", "uploading"], ["b", "error"]))).toStrictEqual({ kind: "failed", name: "b.txt" });
    });

    it("ends as edited when the text changed, so only the draft pressed on could be sent", () => {
        expect(settleNow(files(["a", "complete"], ["b", "complete"]), "see files, and more")).toStrictEqual({ kind: "edited" });
    });

    it("ends as edited when a file was added while the uploads ran", () => {
        expect(settleNow(files(["a", "complete"], ["b", "uploading"], ["c", "uploading"]))).toStrictEqual({ kind: "edited" });
    });

    it("ends as edited when a waited file was removed from the draft", () => {
        expect(settleNow(files(["a", "uploading"]))).toStrictEqual({ kind: "edited" });
    });

    it("ends as edited when a reference image was added while the uploads ran", () => {
        expect(settleNow(files(["a", "complete"], ["b", "complete"]), "see files", [reference("r1")])).toStrictEqual({ kind: "edited" });
    });

    it("ends as edited when a file that had finished is replaced by another upload", () => {
        const done = startUploadWait({ attachments: [file("a", "complete", "f1"), file("b", "uploading")], references: [], text: "see files" }, "thread-1");
        const replaced = settleUploadWait(
            done,
            { attachments: [file("a", "complete", "f2"), file("b", "complete", "f3")], references: [], text: "see files" },
            "thread-1",
        );

        expect(replaced).toStrictEqual({ kind: "edited" });
    });

    it("ends as edited when a finished file starts uploading again under the same file id", () => {
        const done = startUploadWait({ attachments: [file("a", "complete", "f1"), file("b", "uploading")], references: [], text: "see files" }, "thread-1");

        expect(
            settleUploadWait(done, { attachments: [file("a", "uploading", "f1"), file("b", "uploading")], references: [], text: "see files" }, "thread-1"),
        ).toStrictEqual({ kind: "edited" });
    });

    it("sends once a re-upload finishes, though it held the old file id while it ran", () => {
        const retried = startUploadWait({ attachments: [file("a", "uploading", "old")], references: [], text: "see files" }, "thread-1");

        expect(settleUploadWait(retried, { attachments: [file("a", "complete", "new")], references: [], text: "see files" }, "thread-1")).toStrictEqual({
            kind: "send",
        });
    });

    it("keeps waiting, not cancelled, when the account was still loading as send was pressed", () => {
        const wait = startUploadWait({ attachments: files(["a", "uploading"]), references: [], text: "see files" }, "thread-1");

        expect(settleUploadWait(wait, { attachments: files(["a", "complete"]), references: [], text: "see files" }, "thread-1", "user-1")).toStrictEqual({
            kind: "send",
        });
    });

    it("ends as retargeted when comparison mode or its models changed while the uploads ran", () => {
        const wait = startUploadWait({ attachments: files(["a", "uploading"]), references: [], target: "", text: "see files" }, "thread-1");
        const done = { attachments: files(["a", "complete"]), references: [], text: "see files" };

        expect(settleUploadWait(wait, { ...done, target: "model-a\nmodel-b" }, "thread-1")).toStrictEqual({ kind: "retargeted" });
        expect(settleUploadWait(wait, { ...done, target: "" }, "thread-1")).toStrictEqual({ kind: "send" });
    });

    it("cancels quietly when the account changed, even in the same chat", () => {
        const wait = startUploadWait({ attachments: files(["a", "uploading"]), references: [], text: "see files" }, "thread-1", "user-1");
        const done = { attachments: files(["a", "complete"]), references: [], text: "see files" };

        expect(settleUploadWait(wait, done, "thread-1", "user-2")).toStrictEqual({ kind: "cancelled" });
        expect(settleUploadWait(wait, done, "thread-1", "user-1")).toStrictEqual({ kind: "send" });
    });

    it("cancels quietly when the chat changed while the send waited", () => {
        expect(
            settleUploadWait(pressed, { attachments: files(["a", "complete"], ["b", "complete"]), references: [], text: "see files" }, "thread-2"),
        ).toStrictEqual({ kind: "cancelled" });
    });
});
