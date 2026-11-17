import { describe, expect, it } from "vitest";

import { settleUploadWait, startUploadWait } from "./upload-send-wait";

type Status = "pending" | "uploading" | "complete" | "error";

/** A draft's attachments from `[id, status]` pairs; each file is named `<id>.txt`. */
const file = (id: string, status: Status) => {
    return { id, name: `${id}.txt`, status };
};

const files = (...list: [string, Status][]) => list.map(([id, status]) => file(id, status));

/** The draft pressed on: two uploads running, "a" and "b", and the text "see files". */
const pressed = startUploadWait({ attachments: files(["a", "uploading"], ["b", "pending"]), text: "see files" }, "thread-1");

/** What the settle step sees for the draft now, in the chat "thread-1". */
const settleNow = (attachments: ReturnType<typeof files>, text = "see files", threadId = "thread-1") =>
    settleUploadWait(pressed, { attachments, text }, threadId);

describe("startUploadWait", () => {
    it("waits on the draft's uploads that are not complete, and remembers the draft pressed on", () => {
        const wait = startUploadWait({ attachments: files(["a", "complete"], ["b", "uploading"], ["c", "pending"]), text: "see files" }, "thread-1");

        expect(wait).toStrictEqual({ attachmentIds: ["b", "c"], draftIds: ["a", "b", "c"], text: "see files", threadId: "thread-1" });
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

    it("cancels quietly when the chat changed while the send waited", () => {
        expect(settleNow(files(["a", "complete"], ["b", "complete"]), "see files", "thread-2")).toStrictEqual({ kind: "cancelled" });
    });
});
