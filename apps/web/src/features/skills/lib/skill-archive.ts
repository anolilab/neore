/**
 * SKILL.md files and skill `.zip` archives on the client: reading an upload
 * into what `skills_io.importSkill` takes, and packing what `exportSkill`
 * returns into a download. The format rules live in
 * `@neore/backend/skills/markdown`, shared with the server.
 */
import type { SkillFileData } from "@neore/backend/skills/markdown";
import { isTextSkillFile, locateSkillInArchive, normalizeSkillFilePath, SKILL_IMPORT_LIMITS, SKILL_MARKDOWN_FILE } from "@neore/backend/skills/markdown";

import type { JsZipLike, JsZipWriter, LoadZip } from "@/lib/zip";

export interface SkillUpload {
    filename: string;
    files: SkillFileData[];
    markdown: string;
}

const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = "";

    for (let index = 0; index < view.length; index += 0x80_00) {
        binary += String.fromCodePoint(...view.subarray(index, index + 0x80_00));
    }

    return btoa(binary);
};

const fromBase64 = (content: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(content), (character) => character.codePointAt(0)!);

/** Largest archive read at all: the SKILL.md cap plus the files budget, with room for compression overhead. */
export const MAX_SKILL_ARCHIVE_BYTES = SKILL_IMPORT_LIMITS.totalFileBytes + SKILL_IMPORT_LIMITS.markdownBytes + 1024 * 1024;

/** The picked file is over {@link MAX_SKILL_ARCHIVE_BYTES}; the caller words it (translated). */
export class SkillArchiveTooLargeError extends Error {
    public readonly maxMegabytes = Math.round(MAX_SKILL_ARCHIVE_BYTES / 1024 / 1024);

    public constructor() {
        super(`The file is larger than ${String(Math.round(MAX_SKILL_ARCHIVE_BYTES / 1024 / 1024))} MB`);
        this.name = "SkillArchiveTooLargeError";
    }
}

/**
 * Reads a `.md` or a `.zip` the user picked. Throws
 * {@link SkillArchiveTooLargeError} for an oversized file, and with the
 * server-shared format message when the archive holds no single skill.
 */
export const readSkillUpload = async (file: File, loadZip: LoadZip): Promise<SkillUpload> => {
    if (file.size > MAX_SKILL_ARCHIVE_BYTES) {
        throw new SkillArchiveTooLargeError();
    }

    if (!file.name.toLowerCase().endsWith(".zip")) {
        return { filename: file.name, files: [], markdown: await file.text() };
    }

    const zip: JsZipLike = await loadZip(await file.arrayBuffer());
    const entries = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => {
            return { entry, path: entry.name };
        });
    const located = locateSkillInArchive(entries);

    if (!located.ok) {
        throw new Error(located.errors.join("; "));
    }

    const files: SkillFileData[] = [];

    for (const { entry, path } of located.files) {
        const normalized = normalizeSkillFilePath(path);

        if (!normalized) {
            continue;
        }

        const bytes = await entry.async("arraybuffer");

        files.push(
            isTextSkillFile(normalized)
                ? { content: new TextDecoder().decode(bytes), encoding: "utf8", path: normalized }
                : { content: toBase64(bytes), encoding: "base64", path: normalized },
        );
    }

    return { filename: file.name, files, markdown: new TextDecoder().decode(await located.skill.entry.async("arraybuffer")) };
};

/**
 * The download for an exported skill: `<slug>.md` alone, or `<slug>.zip` with
 * `<slug>/SKILL.md` and its files — the layout `readSkillUpload` reads back
 * and Claude installs from.
 */
export const buildSkillDownload = async (
    exported: { files: ReadonlyArray<SkillFileData>; markdown: string; slug: string },
    createZip: () => Promise<JsZipWriter>,
): Promise<{ blob: Blob; filename: string }> => {
    if (exported.files.length === 0) {
        return { blob: new Blob([exported.markdown], { type: "text/markdown;charset=utf-8" }), filename: `${exported.slug}.md` };
    }

    const zip = await createZip();

    zip.file(`${exported.slug}/${SKILL_MARKDOWN_FILE}`, exported.markdown);

    for (const file of exported.files) {
        zip.file(`${exported.slug}/${file.path}`, file.encoding === "utf8" ? file.content : fromBase64(file.content));
    }

    return { blob: await zip.generateAsync({ type: "blob" }), filename: `${exported.slug}.zip` };
};

/** Saves a blob through a temporary object URL. */
export const saveBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    link.click();
    // Revoked on the next task: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
};
