/**
 * Files a code-execution or shell run saved to its output directory, as the
 * tool result carries them (`backend/lunora/chat/tools/sandbox-outputs.ts`).
 */
export interface SandboxOutputFile {
    mediaType: string;
    name: string;
    size: number;
    /** A signed URL once read back from the server, the raw `storage:` reference while streaming, empty when unavailable. */
    url: string;
}

export interface SkippedSandboxFile {
    name: string;
    reason: "failed" | "too-large" | "too-many" | "total-too-large" | "unsupported-type";
}

export interface SandboxOutputs {
    files: SandboxOutputFile[];
    skippedFiles: SkippedSandboxFile[];
}
