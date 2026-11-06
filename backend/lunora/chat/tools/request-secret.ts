/**
 * Request Secret tool.
 *
 * The agent asks the user for a secret (an API key, a token) on a card in the
 * chat, so the value never passes through the conversation. It rides the
 * tool-approval round trip, like `askUser` (`ask-user.ts`):
 *
 * - The tool ALWAYS needs approval, so calling it stops the step with a
 *   `tool-approval-request` and the run records its `toolApprovalRuns` snapshot.
 *   The call's input is only labels, a purpose, the destination(s) and an optional format — no value.
 * - The user answers through `chat_request_secret.answerSecretRequest`, never
 *   through `respondToToolApproval` (which refuses this tool). Saving encrypts
 *   the value into `requestedSecrets`; the run resumes with only the opaque
 *   reference (a card with `fields`: one per field), which {@link createAnsweredRequestSecretTool} returns as the
 *   tool result. Declining is a denial with a reason the model reads.
 * - The agent spends the reference with a consumer tool (`use-secret.ts`),
 *   once, before the reply ends (the ciphertext is dropped then; at most 24 hours).
 *
 * Headless runs never see it (`person-tools.ts`), and a time-boxed allow never
 * covers it: it waits for a person. Its name and limits live in
 * `request-secret-constants.ts`, which the run and claim code import without
 * pulling in the agent client.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import type { RequestSecretInput, RequestSecretOutput } from "./request-secret-constants";
import {
    isForbiddenSecretHeader,
    SECRET_HEADER_NAME_MAX,
    SECRET_FIELD_NAME_RE,
    SECRET_FIELDS_MAX,
    SECRET_FORMAT_PREFIX_MAX,
    SECRET_HEADER_NAME_RE,
    SECRET_HEADER_VALUE_MAX,
    SECRET_LABEL_MAX,
    SECRET_PROVIDER_KEY_MAX,
    SECRET_PROVIDERS,
    SECRET_PURPOSE_MAX,
    SECRET_SERVER_NAME_MAX,
} from "./request-secret-constants";

const useSchema = z
    .discriminatedUnion("kind", [
        z
            .object({
                kind: z.literal("provider_key"),
                provider: z.enum(SECRET_PROVIDERS).meta({ description: "Whose API key it is" }),
            })
            .strict(),
        z
            .object({
                header: z
                    .string()
                    .min(1)
                    .max(SECRET_HEADER_NAME_MAX)
                    .regex(SECRET_HEADER_NAME_RE)
                    .refine((name) => !isForbiddenSecretHeader(name), { error: "The transport owns that header" })
                    .meta({ description: 'The header name, e.g. "Authorization"' }),
                kind: z.literal("mcp_header"),
                server: z.string().min(1).max(SECRET_SERVER_NAME_MAX).meta({ description: "The name of one of the user's saved MCP servers" }),
            })
            .strict(),
    ])
    .meta({ description: "Where the secret will go. The user sees this on the card and the secret can be used nowhere else." });

const formatSchema = z
    .object({
        minLength: z.int().min(1).max(SECRET_HEADER_VALUE_MAX).optional().meta({ description: "The fewest characters the value may have" }),
        prefix: z.string().min(1).max(SECRET_FORMAT_PREFIX_MAX).optional().meta({ description: 'What the value must start with, e.g. "sk-"' }),
    })
    .strict()
    .meta({ description: "Optional shape the value must have; a value that does not fit is refused and nothing is stored." });

const fieldSchema = z
    .object({
        format: formatSchema.optional(),
        label: z.string().min(1).max(SECRET_LABEL_MAX).meta({ description: 'What this field is, e.g. "Password"' }),
        name: z.string().regex(SECRET_FIELD_NAME_RE).meta({ description: 'Key of this secret in the result, e.g. "password"; unique in the card' }),
        use: useSchema,
    })
    .strict();

const inputSchema = z
    .object({
        fields: z
            .array(fieldSchema)
            .min(1)
            .max(SECRET_FIELDS_MAX)
            .optional()
            .meta({ description: "Several secrets on one card (e.g. username and password); each is stored on its own. Use this instead of `use`." }),
        format: formatSchema.optional(),
        label: z.string().min(1).max(SECRET_LABEL_MAX).meta({ description: 'What the secret is, e.g. "OpenAI API key"' }),
        purpose: z.string().min(1).max(SECRET_PURPOSE_MAX).optional().meta({ description: "One line on why you need it, shown to the user" }),
        use: useSchema.optional(),
    })
    .strict()
    .refine((input) => (input.use === undefined) !== (input.fields === undefined), { error: "Give either `use` or `fields`" })
    .refine((input) => input.fields === undefined || input.format === undefined, { error: "With `fields`, put `format` on each field" })
    .refine((input) => input.fields === undefined || new Set(input.fields.map((field) => field.name)).size === input.fields.length, {
        error: "Field names must be unique",
    })
    // A provider key is stored up to SECRET_PROVIDER_KEY_MAX characters, so a card that requires more could never be answered.
    .refine(
        (input) =>
            (input.fields ?? (input.use === undefined ? [] : [{ format: input.format, use: input.use }])).every(
                ({ format, use }) => use.kind !== "provider_key" || (format?.minLength ?? 0) <= SECRET_PROVIDER_KEY_MAX,
            ),
        { error: `A provider key cannot require more than ${SECRET_PROVIDER_KEY_MAX} characters` },
    );

const DESCRIPTION = `Ask the user for a secret (an API key or token) you need, on a card that keeps the value out of the chat.
Use it instead of asking the user to paste a key into the conversation. You never see the value: the tool returns a reference, which you spend with exactly one consumer tool, in the reply that receives it (a reference does not outlive the reply).
- label: what the secret is.
- purpose: optional one line on why you need it.
- format: optional { prefix, minLength } the value must fit (e.g. { prefix: "sk-" }); the card and the server refuse a value that does not, and nothing is stored.
- fields: instead of use, a list of up to ${SECRET_FIELDS_MAX} { name, label, use, format? } to ask for several secrets (e.g. username and password) on one card. Each is stored on its own and the result is { refs: { <name>: <reference> } }; spend each reference separately.
- use: where it will go. { kind: "provider_key", provider } saves it as the user's own API key for that provider (then use saveSecretAsProviderKey); { kind: "mcp_header", server, header } sets a header on one of their saved MCP servers (then use setMcpServerSecret). It cannot be used anywhere else.
The run pauses until the user answers. If they decline, do not ask again; continue without it or point them to Settings.`;

/**
 * The registered tool. Its execute runs only if something approves the call
 * WITHOUT an answer — which `respondToToolApproval` refuses — so it reports
 * that nothing was provided rather than inventing a reference.
 */
const requestSecretTool = createTool<RequestSecretInput, RequestSecretOutput, ToolContext>({
    description: DESCRIPTION,
    execute: async () => {
        return { message: "No secret was provided.", status: "unavailable" };
    },
    inputSchema,
    needsApproval: true,
    title: "Request Secret",
});

/** The resume carries one reference, or the JSON of `{ name: reference }` for a card with fields (see `secretResumeArgs`). */
const answeredOutput = (answer: string): RequestSecretOutput =>
    answer.startsWith("{") ? { refs: JSON.parse(answer) as Record<string, string>, status: "saved" } : { ref: answer, status: "saved" };

/** The same tool for one resumed run, answering with the reference of the stored value. */
export const createAnsweredRequestSecretTool = (answer: string) =>
    createTool<RequestSecretInput, RequestSecretOutput, ToolContext>({
        description: DESCRIPTION,
        execute: async () => answeredOutput(answer),
        inputSchema,
        needsApproval: true,
        title: "Request Secret",
    });

export type { RequestSecretInput, RequestSecretOutput } from "./request-secret-constants";
export { REQUEST_SECRET_TOOL_NAME } from "./request-secret-constants";

export default requestSecretTool;
