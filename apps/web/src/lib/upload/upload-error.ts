/**
 * How an upload to the backend's upload route failed (`upload-file.ts`). Kept
 * apart from the uploader, which pulls in the session-token server function,
 * so error handling can be imported and tested without it.
 */

/** Why an upload failed, as far as the browser can tell. */
export type UploadFailure =
    /** 404/410: the upload is gone — reaped, or it expired mid-way. */
    | "expired"
    /** The request never completed: offline, CORS, or the connection dropped. */
    | "network"
    /** Any other refusal: signed out, rate limited, or a server error. */
    | "rejected"
    /** 413: the declared size is over what the declared type may weigh. */
    | "too-large"
    /** 415: a type the backend does not accept. */
    | "unsupported";

export class UploadFailedError extends Error {
    public readonly reason: UploadFailure;

    public readonly status: number;

    public constructor(reason: UploadFailure, status: number, cause?: unknown) {
        super(`Upload failed (${reason}${status ? `, HTTP ${String(status)}` : ""})`, { cause });
        this.name = "UploadFailedError";
        this.reason = reason;
        this.status = status;
    }
}

export const failureFor = (status: number): UploadFailure => {
    switch (status) {
        case 0: {
            return "network";
        }
        case 404:
        case 410: {
            return "expired";
        }
        case 413: {
            return "too-large";
        }
        case 415: {
            return "unsupported";
        }
        default: {
            return "rejected";
        }
    }
};
