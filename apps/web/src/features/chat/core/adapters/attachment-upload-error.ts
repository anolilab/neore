/**
 * Why an upload failed, for the composer to word (Lingui) — the server's and
 * the browser's own texts are English whatever the locale.
 */
export type AttachmentUploadFailure =
    /** The bytes did not look like the declared type. */
    | "content-mismatch"
    /** The signed upload URL expired, or the staged upload was gone at finalize. */
    | "expired"
    /** The PUT failed: network, or the storage endpoint refused it. */
    | "failed"
    /** A type the backend does not accept. */
    | "unsupported";

/** A recognised upload failure; too-large files are `AttachmentTooLargeError` instead. */
export class AttachmentUploadError extends Error {
    public readonly fileName: string;

    public readonly reason: AttachmentUploadFailure;

    public constructor(fileName: string, reason: AttachmentUploadFailure, cause?: unknown) {
        super(`${fileName}: upload ${reason}`, { cause });
        this.name = "AttachmentUploadError";
        this.fileName = fileName;
        this.reason = reason;
    }
}
