/**
 * Ollama's `POST /api/pull` streams NDJSON progress:
 *
 *   {"status":"pulling manifest"}
 *   {"status":"pulling 6a0746a1ec1a","digest":"sha256:6a07…","total":2019377376,"completed":241970}
 *   {"status":"verifying sha256 digest"}
 *   {"status":"writing manifest"}
 *   {"status":"success"}
 *
 * or `{"error":"pull model manifest: file does not exist"}` at any point. A
 * model is several layers, each reported with its own `total`, so the progress
 * bar tracks the layer in flight — Ollama gives no overall total up front.
 */

export interface PullProgress {
    completed?: number;
    digest?: string;
    done: boolean;
    error?: string;
    /** 0–100 for the current layer, when it reported a size. */
    percent?: number;
    status: string;
    total?: number;
}

/** Splits an NDJSON byte stream (already decoded) into complete lines across chunk boundaries. */
export const createLineSplitter = () => {
    let buffer = "";

    return {
        flush: (): string[] => {
            const rest = buffer.trim();

            buffer = "";

            return rest ? [rest] : [];
        },
        feed: (chunk: string): string[] => {
            buffer += chunk;

            const parts = buffer.split("\n");

            buffer = parts.pop() ?? "";

            return parts.map((line) => line.trim()).filter(Boolean);
        },
    };
};

/** One NDJSON line → progress, or `undefined` for a line that is not JSON. */
export const parsePullProgress = (line: string): PullProgress | undefined => {
    let json: unknown;

    try {
        json = JSON.parse(line);
    } catch {
        return undefined;
    }

    if (!json || typeof json !== "object") {
        return undefined;
    }

    const record = json as { completed?: unknown; digest?: unknown; error?: unknown; status?: unknown; total?: unknown };

    if (typeof record.error === "string") {
        return { done: true, error: record.error, status: "error" };
    }

    const status = typeof record.status === "string" ? record.status : "";
    const total = typeof record.total === "number" && record.total > 0 ? record.total : undefined;
    const completed = typeof record.completed === "number" && record.completed >= 0 ? record.completed : undefined;
    const progress: PullProgress = { done: status === "success", status };

    if (typeof record.digest === "string") {
        progress.digest = record.digest;
    }

    if (total !== undefined) {
        progress.total = total;
        progress.completed = completed ?? 0;
        progress.percent = Math.min(100, Math.floor(((completed ?? 0) / total) * 100));
    }

    return progress;
};

/**
 * A model name as `ollama pull` accepts it: `llama3.2`, `llama3.2:3b`,
 * `hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M`,
 * `namespace/model:tag`. Refuses whitespace, URLs with a scheme and anything
 * long enough to be a paste accident.
 */
const MODEL_NAME_RE = /^[\w.-]+(?:\/[\w.-]+)*(?::[\w.-]+)?$/u;

export const isValidOllamaModelName = (name: string): boolean => name.length > 0 && name.length <= 200 && MODEL_NAME_RE.test(name);

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `4920753328` → `4.6 GB`. Binary units, as Ollama's own CLI prints them. */
export const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
};
