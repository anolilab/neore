/**
 * Skill import and export as SKILL.md (the Agent Skills format) — see
 * `markdown.ts` for the format and the caps.
 *
 * Import parses on the SERVER, whatever the client already checked, and
 * creates the skill through `createSkill` itself, so every rule a skill
 * created in the editor meets (slug, quota, organization) applies unchanged.
 * Additional files are stored before the skill is created and removed again
 * if it cannot be, so a refused import leaves nothing behind.
 *
 * Export returns the markdown and the additional files; the client offers a
 * `.md` download, or packs a `.zip` when there are files.
 */
import { LunoraError, v } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { readStoredObject } from "../lib/storage-read";
import { getToolRegistry } from "./jit-tool-loader";
import {
    classifySkillFile,
    isTextSkillFile,
    parseSkillMarkdown,
    SKILL_IMPORT_LIMITS,
    type SkillFileData,
    skillFileBytes,
    skillToMarkdown,
    validateSkillFiles,
} from "./markdown";
import { MAX_LENGTH } from "../lib/validators";
import { withDependency } from "../lib/dependency";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    bash: "bash",
    js: "javascript",
    json: "json",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    ts: "typescript",
    yaml: "yaml",
    yml: "yaml",
};

/** Text or opaque bytes — never a type a browser would render (stored-XSS). */
const SKILL_FILE_CONTENT_TYPES = ["text/plain; charset=utf-8", "application/octet-stream"] as const;

const vSkillFileData = v.object({
    content: v.string(),
    encoding: v.union(v.literal("utf8"), v.literal("base64")),
    path: v.string(),
});

const toBytes = (file: SkillFileData): Uint8Array<ArrayBuffer> =>
    file.encoding === "utf8"
        ? new Uint8Array(new TextEncoder().encode(file.content))
        : Uint8Array.from(atob(file.content), (character) => character.codePointAt(0)!);

const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = "";

    for (let index = 0; index < view.length; index += 0x80_00) {
        binary += String.fromCodePoint(...view.subarray(index, index + 0x80_00));
    }

    return btoa(binary);
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The first of `slug`, `slug-2`, `slug-3`, … the user does not have yet. */
export const findFreeSkillSlug = internalQuery
    .input({ slug: v.string(), userId: v.string() })
    .output(v.string())
    .query(async ({ args: { slug, userId }, ctx }) => {
        const { page: skills } = await ctx.db.skills.findMany({ where: { userId } });
        const taken = new Set(skills.map((skill) => skill.slug));

        if (!taken.has(slug)) {
            return slug;
        }

        for (let suffix = 2; suffix < 100; suffix += 1) {
            const candidate = `${slug.slice(0, 60)}-${String(suffix)}`;

            if (!taken.has(candidate)) {
                return candidate;
            }
        }

        throw new LunoraError("CONFLICT", `A skill with slug '${slug}' already exists`);
    });

/** Records stored additional files on a skill the importing user owns. */
export const saveImportedSkillFiles = internalMutation
    .input({
        files: v.array(
            v.object({
                hash: v.string(),
                language: v.optional(v.string()),
                name: v.string(),
                sizeBytes: v.number(),
                storageId: v.string(),
                type: v.string(),
            }),
        ),
        skillId: v.id("skills"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const skill = await ctx.db.skills.findFirst({ where: { _id: args.skillId } });

        if (!skill || skill.userId !== args.userId) {
            throw new LunoraError("NOT_FOUND", "Skill not found");
        }

        for (const file of args.files) {
            await ctx.db.insert("skillFiles", { ...file, skillId: args.skillId });
        }

        return null;
    });

/** A skill's additional files. Internal: callers prove read access first (`exportSkill`). */
export const listSkillFilesInternal = internalQuery
    .input({ skillId: v.id("skills") })
    .output(v.array(v.object({ name: v.string(), sizeBytes: v.number(), storageId: v.string() })))
    .query(async ({ args, ctx }) => {
        const { page: files } = await ctx.db.skillFiles.findMany({ limit: SKILL_IMPORT_LIMITS.files, where: { skillId: args.skillId } });

        return files.map((file) => {
            return { name: file.name, sizeBytes: file.sizeBytes, storageId: file.storageId };
        });
    });

/**
 * Creates a skill from a SKILL.md and its additional files. Unknown tools are
 * dropped with a warning (a skill written for Claude Code names tools this app
 * does not have); a slug the user already uses gets a numeric suffix.
 */
export const importSkill = authAction
    .use(rateLimit("skills/create"))
    .input({
        filename: v.optional(v.string().max(MAX_LENGTH.short)),
        files: v.optional(v.array(vSkillFileData)),
        markdown: v.string().max(MAX_LENGTH.document),
        visibility: v.optional(v.union(v.literal("private"), v.literal("organization"))),
    })
    .output(v.object({ skillId: v.id("skills"), slug: v.string(), warnings: v.array(v.string()) }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const parsed = parseSkillMarkdown(args.markdown);

        if (!parsed.ok) {
            throw new LunoraError("BAD_REQUEST", parsed.errors.join("; "));
        }

        const files = args.files ?? [];
        const fileErrors = validateSkillFiles(files);

        if (fileErrors.length > 0) {
            throw new LunoraError("BAD_REQUEST", fileErrors.join("; "));
        }

        const { skill } = parsed;
        const warnings = [...parsed.warnings];
        const knownTools = new Set(getToolRegistry().map((tool) => tool.name));
        const keepKnown = (tools: string[] | undefined, label: string): string[] | undefined => {
            if (!tools) {
                return undefined;
            }

            const unknown = tools.filter((tool) => !knownTools.has(tool));

            if (unknown.length > 0) {
                warnings.push(`${label}: not available here, ignored: ${unknown.join(", ")}`);
            }

            const known = tools.filter((tool) => knownTools.has(tool));

            return known.length > 0 ? known : undefined;
        };
        const config = skill.config
            ? {
                  ...skill.config,
                  additionalTools: keepKnown(skill.config.additionalTools, "allowed-tools"),
                  disabledTools: keepKnown(skill.config.disabledTools, "disabled-tools"),
              }
            : undefined;
        const slug = await ctx.runQuery(internal.skills.io.findFreeSkillSlug, { slug: skill.slug, userId });

        if (slug !== skill.slug) {
            warnings.push(`You already have a skill named '${skill.slug}'; this one was imported as '${slug}'`);
        }

        // Store the files first: a failed create then only has objects to remove.
        const prefix = `skill-files/${userId}/${crypto.randomUUID()}`;
        const stored: { hash: string; language?: string; name: string; sizeBytes: number; storageId: string; type: string }[] = [];

        try {
            for (const [index, file] of files.entries()) {
                const bytes = toBytes(file);
                const storageId = `${prefix}/${String(index)}`;
                const extension = file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase();

                await withDependency("file storage", () =>
                    ctx.storage.store(storageId, bytes.buffer, {
                        allowedContentTypes: SKILL_FILE_CONTENT_TYPES,
                        contentType: isTextSkillFile(file.path) ? SKILL_FILE_CONTENT_TYPES[0] : SKILL_FILE_CONTENT_TYPES[1],
                        maxSize: SKILL_IMPORT_LIMITS.fileBytes[classifySkillFile(file.path)],
                    }),
                );
                stored.push({
                    hash: await sha256Hex(bytes),
                    language: LANGUAGE_BY_EXTENSION[extension],
                    name: file.path,
                    sizeBytes: skillFileBytes(file),
                    storageId,
                    type: classifySkillFile(file.path),
                });
            }

            const skillId = await ctx.runMutation(api.skills.functions.createSkill, {
                category: skill.category,
                config,
                description: skill.description,
                icon: skill.icon,
                instructions: skill.instructions,
                name: skill.name,
                slug,
                source: { filename: (args.filename ?? "SKILL.md").slice(0, 255), type: "upload", uploadedAt: Date.now() },
                tags: skill.tags,
                variables: skill.variables,
                version: skill.version,
                visibility: args.visibility ?? "private",
            });

            if (stored.length > 0) {
                await ctx.runMutation(internal.skills.io.saveImportedSkillFiles, { files: stored, skillId: skillId as Id<"skills">, userId });
            }

            ctx.log.event("skills.import", { fileCount: stored.length, skillId, warningCount: warnings.length });

            return { skillId: skillId as Id<"skills">, slug, warnings };
        } catch (error) {
            await Promise.allSettled(stored.map(async ({ storageId }) => await ctx.storage.delete(storageId)));

            throw error;
        }
    });

/**
 * A skill as SKILL.md plus its additional files, for anyone who may read it
 * (`getSkill` decides and throws otherwise). Text files come back as UTF-8,
 * everything else as base64.
 */
export const exportSkill = authAction
    .use(rateLimit("skills/invoke"))
    .input({ skillId: v.id("skills") })
    .output(
        v.object({
            files: v.array(vSkillFileData),
            markdown: v.string(),
            slug: v.string(),
        }),
    )
    .action(async ({ args, ctx }) => {
        const skill = await ctx.runQuery(api.skills.functions.getSkill, { skillId: args.skillId });

        if (!skill) {
            throw new LunoraError("NOT_FOUND", "Skill not found");
        }

        const files = await ctx.runQuery(internal.skills.io.listSkillFilesInternal, { skillId: args.skillId });
        const exported: SkillFileData[] = [];

        for (const file of files) {
            const { bytes } = await readStoredObject(ctx.storage, file.storageId, { maxBytes: SKILL_IMPORT_LIMITS.fileBytes.asset * 5 });

            exported.push(
                isTextSkillFile(file.name)
                    ? { content: new TextDecoder().decode(bytes), encoding: "utf8", path: file.name }
                    : { content: toBase64(bytes), encoding: "base64", path: file.name },
            );
        }

        ctx.log.event("skills.export", { fileCount: exported.length, skillId: args.skillId });

        return {
            files: exported,
            markdown: skillToMarkdown({
                category: skill.category,
                config: skill.config,
                description: skill.description,
                icon: skill.icon,
                instructions: skill.instructions,
                name: skill.name,
                slug: skill.slug,
                tags: skill.tags,
                variables: skill.variables,
                version: skill.version,
            }),
            slug: skill.slug,
        };
    });
