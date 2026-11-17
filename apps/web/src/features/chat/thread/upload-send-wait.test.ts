import { describe, expect, it } from "vitest";

import { settleUploadWait, uploadWaitIds } from "./upload-send-wait";

type Status = "pending" | "uploading" | "complete" | "error";

const attachment = (id: string, status: Status) => {
    return { id, name: `${id}.txt`, status };
};

const wait = { attachmentIds: ["a", "b"], threadId: "thread-1" };

describe("settleUploadWait", () => {
    it("keeps waiting while a waited upload is still running", () => {
        expect(settleUploadWait(wait, [attachment("a", "complete"), attachment("b", "uploading")], "thread-1")).toStrictEqual({ kind: "waiting" });
        expect(settleUploadWait(wait, [attachment("a", "pending"), attachment("b", "complete")], "thread-1")).toStrictEqual({ kind: "waiting" });
    });

    it("sends once every waited upload is complete", () => {
        expect(settleUploadWait(wait, [attachment("a", "complete"), attachment("b", "complete")], "thread-1")).toStrictEqual({ kind: "send" });
    });

    it("stops at a failed upload and names the file", () => {
        expect(settleUploadWait(wait, [attachment("a", "complete"), attachment("b", "error")], "thread-1")).toStrictEqual({
            kind: "failed",
            name: "b.txt",
        });
    });

    it("reports a failure even while another waited upload still runs", () => {
        expect(settleUploadWait(wait, [attachment("a", "uploading"), attachment("b", "error")], "thread-1")).toStrictEqual({
            kind: "failed",
            name: "b.txt",
        });
    });

    it("cancels when a waited file was removed from the draft", () => {
        expect(settleUploadWait(wait, [attachment("a", "uploading")], "thread-1")).toStrictEqual({ kind: "cancelled" });
    });

    it("cancels when the chat changed while the send waited", () => {
        expect(settleUploadWait(wait, [attachment("a", "complete"), attachment("b", "complete")], "thread-2")).toStrictEqual({
            kind: "cancelled",
        });
    });
});

describe("uploadWaitIds", () => {
    it("waits on every draft attachment that is not yet complete", () => {
        const draft = [attachment("a", "complete"), attachment("b", "uploading"), attachment("c", "pending")];

        expect(uploadWaitIds(draft, null)).toStrictEqual(["b", "c"]);
    });

    it("keeps the ids of an earlier press and adds the uploads started since", () => {
        const draft = [attachment("b", "uploading"), attachment("c", "pending")];

        expect(uploadWaitIds(draft, { attachmentIds: ["b"], threadId: "thread-1" })).toStrictEqual(["b", "c"]);
    });
});
