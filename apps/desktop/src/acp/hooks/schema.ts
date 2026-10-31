/* eslint-disable import/no-namespace -- zod/consistent-import requires the namespace form, which this rule forbids */

/**
 * `.neore/hooks.json`, versioned and strict. The file is repository content: nothing in it is believed until
 * the person has approved this exact file in the device window (`approvals.ts`).
 */
import * as z from "zod";

import { globProblem } from "./glob";

export const HOOKS_VERSION = 1;
export const MAX_HOOKS = 8;
export const MAX_PROMPT = 4000;
export const MAX_NAME = 60;
export const MAX_FILE_BYTES = 64 * 1024;

export type HookEvent = "created" | "deleted" | "manual" | "saved";

// eslint-disable-next-line no-control-regex -- control characters are what is being refused
const CONTROL = /[\u{0}-\u{1F}\u{7F}]/u;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, "an id is lowercase letters, digits and dashes");
const nameSchema = z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME)
    .refine((value) => !CONTROL.test(value), "a name has no control characters");
const promptSchema = z
    .string()
    .max(MAX_PROMPT)
    .refine((value) => value.trim() !== "", "a prompt is not empty");

const fileHook = <Event extends "created" | "deleted" | "saved">(on: Event) =>
    z.strictObject({
        glob: z.string().superRefine((value, context) => {
            const problem = globProblem(value);

            if (problem !== null) {
                context.addIssue({ code: "custom", message: problem });
            }
        }),
        id: idSchema,
        name: nameSchema,
        on: z.literal(on),
        prompt: promptSchema,
    });

const hookSchema = z.discriminatedUnion("on", [
    fileHook("created"),
    fileHook("saved"),
    fileHook("deleted"),
    z.strictObject({ id: idSchema, name: nameSchema, on: z.literal("manual"), prompt: promptSchema }),
]);

const hooksFileSchema = z
    .strictObject({
        hooks: z.array(hookSchema).max(MAX_HOOKS),
        version: z.literal(HOOKS_VERSION),
    })
    .refine((file) => new Set(file.hooks.map((entry) => entry.id)).size === file.hooks.length, "hook ids are unique");

export type Hook = z.infer<typeof hookSchema>;

export type ParsedHooks = { error: string; ok: false } | { hooks: Hook[]; ok: true };

const MAX_ERROR_CHARS = 300;

/** Parses the file's text. Never throws: an unreadable or unknown file is a reason, and fires nothing. */
export const parseHooks = (text: string): ParsedHooks => {
    if (text.length > MAX_FILE_BYTES) {
        return { error: `the file is larger than ${String(MAX_FILE_BYTES)} bytes`, ok: false };
    }

    let json: unknown;

    try {
        json = JSON.parse(text);
    } catch {
        return { error: "the file is not valid JSON", ok: false };
    }

    const result = hooksFileSchema.safeParse(json);

    if (result.success) {
        return { hooks: result.data.hooks, ok: true };
    }

    const [issue] = result.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;

    return { error: `${where}${issue?.message ?? "invalid"}`.slice(0, MAX_ERROR_CHARS), ok: false };
};
