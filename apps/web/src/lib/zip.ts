/**
 * JSZip behind the two small shapes the app uses — reading an archive
 * (knowledge imports, skill uploads) and writing one (skill export) — loaded
 * on first use, so it never reaches a page that does not open a `.zip`.
 */

export interface JsZipLike {
    files: Record<string, { async: (type: "arraybuffer") => Promise<ArrayBuffer>; dir: boolean; name: string }>;
}

export type LoadZip = (data: ArrayBuffer) => Promise<JsZipLike>;

export interface JsZipWriter {
    file: (path: string, data: string | Uint8Array) => void;
    generateAsync: (options: { type: "blob" }) => Promise<Blob>;
}

export const loadJsZip: LoadZip = async (data) => {
    const { default: JSZip } = await import("jszip");

    return (await JSZip.loadAsync(data)) as unknown as JsZipLike;
};

export const createJsZip = async (): Promise<JsZipWriter> => {
    const { default: JSZip } = await import("jszip");

    return new JSZip() as unknown as JsZipWriter;
};
