/**
 * The reply action's media half. Downloads (`lib/platform-media.ts`) and
 * storage (`storeFile`) are faked — the adapters and `fetchMedia` have their
 * own tests — so these pin what reaches the saved message and the model, and
 * what goes back to the sender.
 */
import { MODEL_REGISTRY } from "@neore/ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundAttachment } from "./lib/media";
import { MediaDownloadError, MESSENGER_MAX_TRANSCRIPTIONS, MESSENGER_MEDIA_MAX_BYTES, MESSENGER_TRANSCRIBE_MAX_BYTES } from "./lib/media";
import { ingestAttachments, sanitizeAttachmentName, sendReplyMedia } from "./media";
import { MESSENGER_MEDIA_MODEL } from "./respond";

const platform = vi.hoisted(() => {
    return {
        downloads: new Map<string, Error | { bytes: Uint8Array; contentType: string | null }>(),
        sendResult: "sent" as "sent" | "unsupported" | "window_closed",
        sent: [] as { mediaType: string; name: string }[],
    };
});

vi.mock("./lib/platform-media", () => {
    return {
        downloadAttachment: async (_platform: string, _keys: unknown, attachment: InboundAttachment) => {
            const result = platform.downloads.get(attachment.ref);

            if (!result || result instanceof Error) {
                throw result ?? new Error("not found");
            }

            return result;
        },
        sendPlatformMedia: async (_delivery: unknown, file: { mediaType: string; name: string }) => {
            platform.sent.push({ mediaType: file.mediaType, name: file.name });

            return platform.sendResult;
        },
    };
});

vi.mock("../agent/client/files", () => {
    return {
        storeFile: async (_context: unknown, blob: Blob, options: { filename?: string }) => {
            return {
                file: {
                    fileId: `file:${options.filename ?? "?"}`,
                    storageId: `agent-files/${blob.type.replace("/", "-")}`,
                    url: `https://signed.example/${options.filename ?? ""}`,
                },
            };
        },
    };
});

const TEXT = (value: string) => {
    return { bytes: new TextEncoder().encode(value), contentType: "text/plain" };
};
const BYTES = (contentType: string | null) => {
    return { bytes: new Uint8Array([1, 2, 3]), contentType };
};

const transcriptions: string[] = [];

/** The owner's daily audio quota (`chat_daily_charge.chargeDailyUnit`): units left, and what was charged. */
const audioQuota = { charged: [] as string[], left: Infinity };

const context = (transcript: string | Error = "turn left at the bakery") =>
    ({
        runAction: async (_reference: unknown, args: { audioUrl: string }) => {
            transcriptions.push(args.audioUrl);

            if (transcript instanceof Error) {
                throw transcript;
            }

            return { chunks: [], model: "fal-ai/whisper", text: transcript };
        },
        runMutation: async (_reference: unknown, args: { kind: string; userId: string }) => {
            if (audioQuota.left <= 0) {
                return false;
            }

            audioQuota.left -= 1;
            audioQuota.charged.push(`${args.kind}:${args.userId}`);

            return true;
        },
    }) as never;

const ingest = async (attachments: InboundAttachment[], caption?: string, ctx = context()) =>
    await ingestAttachments(ctx, { attachments, caption, keys: {}, platform: "telegram", threadId: "thread1", userId: "owner" });

beforeEach(() => {
    platform.downloads.clear();
    platform.sent = [];
    platform.sendResult = "sent";
    transcriptions.length = 0;
    audioQuota.charged = [];
    audioQuota.left = Infinity;
});

describe(ingestAttachments, () => {
    it("stores an image and a PDF as parts the model reads, and keeps the caption", async () => {
        platform.downloads.set("img", BYTES("image/jpeg"));
        platform.downloads.set("pdf", BYTES("application/octet-stream"));

        const result = await ingest(
            [
                { kind: "image", ref: "img" },
                { kind: "file", name: "q3.pdf", ref: "pdf" },
            ],
            "what do these say?",
        );

        expect(result).toStrictEqual({
            fileIds: ["file:image.jpg", "file:q3.pdf"],
            hasContent: true,
            parts: [
                { image: "storage:agent-files/image-jpeg", mediaType: "image/jpeg", type: "image" },
                { data: "storage:agent-files/application-pdf", filename: "q3.pdf", mediaType: "application/pdf", type: "file" },
            ],
            text: "what do these say?",
        });
    });

    it("transcribes a voice note from its stored copy and keeps the recording attached, not as a part", async () => {
        platform.downloads.set("voice", BYTES("audio/ogg"));

        const result = await ingest([{ kind: "voice", mimeType: "audio/ogg", ref: "voice" }]);

        expect(transcriptions).toStrictEqual(["https://signed.example/voice-message.ogg"]);
        expect(result.fileIds).toStrictEqual(["file:voice-message.ogg"]);
        expect(result.parts).toStrictEqual([]);
        expect(result.text).toBe("[Voice message transcript]\nturn left at the bakery");
    });

    it("charges each transcription to the owner's daily audio quota, and skips it once that is spent", async () => {
        platform.downloads.set("v1", BYTES("audio/ogg"));
        platform.downloads.set("v2", BYTES("audio/ogg"));
        audioQuota.left = 1;

        const result = await ingest([
            { kind: "voice", ref: "v1" },
            { kind: "voice", ref: "v2" },
        ]);

        expect(audioQuota.charged).toStrictEqual(["Audio:owner"]);
        expect(transcriptions).toHaveLength(1);
        expect(result.fileIds).toHaveLength(2);
        expect(result.text).toContain("[Voice message: it could not be transcribed]");
    });

    it(`transcribes at most ${String(MESSENGER_MAX_TRANSCRIPTIONS)} recordings per message, and none over the size cap`, async () => {
        for (const ref of ["v1", "v2", "v3"]) {
            platform.downloads.set(ref, BYTES("audio/ogg"));
        }

        platform.downloads.set("long", { bytes: new Uint8Array(MESSENGER_TRANSCRIBE_MAX_BYTES + 1), contentType: "audio/ogg" });

        const result = await ingest([
            { kind: "voice", ref: "long" },
            { kind: "voice", ref: "v1" },
            { kind: "voice", ref: "v2" },
            { kind: "voice", ref: "v3" },
        ]);

        expect(transcriptions).toHaveLength(MESSENGER_MAX_TRANSCRIPTIONS);
        expect(result.fileIds).toHaveLength(4);
        expect(result.text).toContain("too long to transcribe");
        expect(result.text).toContain(`only ${String(MESSENGER_MAX_TRANSCRIPTIONS)} recordings are transcribed per message`);
    });

    it("still attaches a voice note whose transcription fails, and says so", async () => {
        platform.downloads.set("voice", BYTES("audio/ogg"));

        const result = await ingest([{ kind: "voice", ref: "voice" }], undefined, context(new Error("FAL_API_KEY not configured")));

        expect(result.fileIds).toHaveLength(1);
        expect(result.text).toBe("[Voice message: it could not be transcribed]");
    });

    it("uses the platform's own recognition when there is one, even if the download fails", async () => {
        platform.downloads.set("amr", new Error("expired"));

        const result = await ingest([{ kind: "voice", ref: "amr", transcript: "你好" }]);

        expect(transcriptions).toStrictEqual([]);
        expect(result).toMatchObject({ fileIds: [], hasContent: true, text: "[Voice message transcript]\n你好" });
    });

    it("inlines a text document and names one the model cannot read", async () => {
        platform.downloads.set("notes", TEXT("buy milk"));
        platform.downloads.set("docx", BYTES("application/vnd.openxmlformats-officedocument.wordprocessingml.document"));

        const result = await ingest([
            { kind: "file", name: "notes.txt", ref: "notes" },
            { kind: "file", name: "plan.docx", ref: "docx" },
        ]);

        expect(result.fileIds).toHaveLength(2);
        expect(result.text).toBe(
            "[Document: notes.txt]\nbuy milk\n\n[Attached file: plan.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document) — its contents cannot be read here]",
        );
    });

    it("skips what it may not take — too large, wrong type, too many — and says why", async () => {
        platform.downloads.set("html", BYTES("text/html"));
        platform.downloads.set("big", new MediaDownloadError("too-large", "over"));

        for (const ref of ["a", "b", "c", "d"]) {
            platform.downloads.set(ref, BYTES("image/png"));
        }

        const result = await ingest([
            { kind: "file", name: "page.html", ref: "html" },
            { kind: "file", name: "huge.pdf", ref: "declared-huge", size: MESSENGER_MEDIA_MAX_BYTES + 1 },
            { kind: "file", ref: "big" },
            { kind: "image", ref: "a" },
            { kind: "image", ref: "b" },
            { kind: "image", ref: "c" },
        ]);

        expect(result.text.split("\n\n")).toStrictEqual([
            '[Attachment "page.html" not read: this type of file is not supported]',
            '[Attachment "huge.pdf" not read: it is larger than 20 MB]',
            "[Attachment not read: it is larger than 20 MB]",
            "[Attachment not read: only 5 attachments are read per message]",
        ]);
        expect(result.parts).toHaveLength(2);
    });

    it("has no content when nothing could be read and there is no caption", async () => {
        const result = await ingest([{ kind: "file", ref: "missing" }]);

        expect(result.hasContent).toBe(false);
    });
});

describe(sanitizeAttachmentName, () => {
    it("drops paths and control characters and caps the length, keeping the extension", () => {
        expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
        expect(sanitizeAttachmentName("a\u{0}b\nc.pdf")).toBe("abc.pdf");
        expect(sanitizeAttachmentName(`${"x".repeat(300)}.pdf`)).toHaveLength(120);
        expect(sanitizeAttachmentName(`${"x".repeat(300)}.pdf`)?.endsWith(".pdf")).toBe(true);
        expect(sanitizeAttachmentName("  ")).toBeUndefined();
    });
});

describe(sendReplyMedia, () => {
    const replyContext = (files: { filename?: string; key: string; mediaType: string }[]) =>
        ({
            runQuery: async () => files,
            storage: {
                download: async () => {
                    return { body: new Response(new Uint8Array([1])).body, httpMetadata: {}, size: 1 };
                },
                getSignedUrl: async (key: string) => `https://signed.example/${key}`,
            },
        }) as never;
    const delivery = { platform: "line", platformChatId: "U1" };

    it("uploads each file, and sends a link for one the platform cannot take", async () => {
        const texts: string[] = [];

        platform.sendResult = "unsupported";

        const outcome = await sendReplyMedia(replyContext([{ filename: "q3.pdf", key: "agent-files/abc", mediaType: "application/pdf" }]), {
            delivery,
            keys: {},
            sendText: async (text) => {
                texts.push(text);

                return "sent";
            },
            threadId: "thread1",
            userId: "owner",
        });

        expect(outcome).toBe("sent");
        expect(platform.sent).toStrictEqual([{ mediaType: "application/pdf", name: "q3.pdf" }]);
        expect(texts).toStrictEqual(["q3.pdf: https://signed.example/agent-files/abc"]);
    });

    it("stops at a closed reply window", async () => {
        platform.sendResult = "window_closed";

        const outcome = await sendReplyMedia(
            replyContext([
                { key: "agent-files/a", mediaType: "image/png" },
                { key: "agent-files/b", mediaType: "image/png" },
            ]),
            { delivery, keys: {}, sendText: async () => "sent", threadId: "thread1", userId: "owner" },
        );

        expect(outcome).toBe("window_closed");
        expect(platform.sent).toHaveLength(1);
    });
});

describe("MESSENGER_MEDIA_MODEL", () => {
    it("is an enabled registry model that reads images", () => {
        const model = MODEL_REGISTRY.find((candidate) => candidate.id === MESSENGER_MEDIA_MODEL);

        expect(model?.enabled).toBe(true);
        expect(model?.supportsImages).toBe(true);
    });
});
