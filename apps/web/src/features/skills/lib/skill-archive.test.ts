import { parseSkillMarkdown, skillToMarkdown } from "@neore/backend/skills/markdown";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { createJsZip, loadJsZip } from "@/lib/zip";

import { buildSkillDownload, MAX_SKILL_ARCHIVE_BYTES, readSkillUpload, SkillArchiveTooLargeError } from "./skill-archive";

const SKILL = {
    config: { additionalTools: ["webSearch"] },
    description: "Summarise meeting notes into action items.",
    instructions: "# Meeting notes\n\nList owners and due dates.",
    name: "Meeting Notes",
    slug: "meeting-notes",
    tags: ["meetings"],
};

const asFile = async (blob: Blob, name: string): Promise<File> => new File([await blob.arrayBuffer()], name);

describe("skill download and upload", () => {
    it("round-trips a skill with no files as a single .md", async () => {
        const download = await buildSkillDownload({ files: [], markdown: skillToMarkdown(SKILL), slug: SKILL.slug }, createJsZip);

        expect(download.filename).toBe("meeting-notes.md");

        const upload = await readSkillUpload(await asFile(download.blob, download.filename), loadJsZip);
        const parsed = parseSkillMarkdown(upload.markdown);

        expect(upload.files).toEqual([]);
        expect(parsed.ok && parsed.skill).toEqual(SKILL);
    });

    it("round-trips a skill with text and binary files as a .zip in a skill folder", async () => {
        const files = [
            { content: "# API\n\nGET /notes", encoding: "utf8" as const, path: "references/api.md" },
            { content: "AAEC/w==", encoding: "base64" as const, path: "assets/logo.png" },
        ];
        const download = await buildSkillDownload({ files, markdown: skillToMarkdown(SKILL), slug: SKILL.slug }, createJsZip);

        expect(download.filename).toBe("meeting-notes.zip");

        const zip = await JSZip.loadAsync(await download.blob.arrayBuffer());

        expect(
            Object.keys(zip.files)
                .filter((path) => !zip.files[path]!.dir)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(["meeting-notes/assets/logo.png", "meeting-notes/references/api.md", "meeting-notes/SKILL.md"]);

        const upload = await readSkillUpload(await asFile(download.blob, download.filename), loadJsZip);

        expect(upload.files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual(files.toSorted((a, b) => a.path.localeCompare(b.path)));
        expect(parseSkillMarkdown(upload.markdown).ok).toBe(true);
    });

    it("refuses an archive without a SKILL.md", async () => {
        const zip = new JSZip();

        zip.file("notes/readme.md", "hi");

        const archive = await asFile(await zip.generateAsync({ type: "blob" }), "x.zip");

        await expect(readSkillUpload(archive, loadJsZip)).rejects.toThrow("SKILL.md");
    });

    it("refuses an oversized file with a typed error the dialog can translate", async () => {
        const huge = { name: "big.zip", size: MAX_SKILL_ARCHIVE_BYTES + 1 } as File;

        await expect(readSkillUpload(huge, loadJsZip)).rejects.toBeInstanceOf(SkillArchiveTooLargeError);
    });
});
