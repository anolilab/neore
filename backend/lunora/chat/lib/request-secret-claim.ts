/**
 * Answering a `requestSecret` card (`chat/tools/request-secret.ts`) and keeping
 * the value it carries — `answerSecretRequest`'s core, kept apart from the
 * procedure so it can be driven against a real schema in tests.
 *
 * It is `claimToolApproval` plus one rule each way, like `claimAskUserAnswer`:
 * the claimed request must be a `requestSecret` call, and a saved value must be
 * non-empty and fit the destination the agent named. A throw rolls the claim
 * back. Saving encrypts the value into `requestedSecrets` and hands back only the
 * reference; declining stores nothing. A header's destination also gets the URL of
 * the named server as it is now, so the value goes to that server later and not to
 * another that takes the name.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { SecretFormat, SecretUse } from "../tools/request-secret-constants";
import {
    REQUEST_SECRET_TOOL_NAME,
    SECRET_DECLINED_REASON,
    SECRET_FIELD_NAME_RE,
    SECRET_FIELDS_MAX,
    SECRET_FORMAT_INVALID,
    SECRET_HEADER_VALUE_FORBIDDEN_RE,
    SECRET_LABEL_MAX,
    SECRET_SERVER_MOVED,
    secretFormatProblem,
} from "../tools/request-secret-constants";
import { invalidSecretUse, secretValueMax, storeRequestedSecret } from "./secret-requests";
import type { ClaimResult } from "./tool-approval-claim";
import { claimToolApproval, findPendingRequestOnLatestTurn } from "./tool-approval-claim";

/** `value` answers the first field; `more` the others, in the order the request listed them. */
export type SecretReply = { kind: "decline" } | { kind: "save"; more?: ReadonlyArray<{ expectedUrl: string; value: string }>; value: string };

/** `ref` for a request with one destination; `refs` (by field name) for one with `fields`. */
export type SecretClaim = ClaimResult & { ref?: string; refs?: Record<string, string>; providerKeySaves?: number; use?: SecretUse };

interface StoredRequest {
    fields?: unknown;
    format?: unknown;
    label?: unknown;
    use?: unknown;
}

/** One secret the request asks for, read back from the call's saved input. */
interface AskedField {
    format?: SecretFormat;
    label: string;
    name?: string;
    use: SecretUse;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const asUse = (value: unknown): SecretUse | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    if (value.kind === "provider_key" && typeof value.provider === "string") {
        return { kind: "provider_key", provider: value.provider };
    }

    if (value.kind === "mcp_header" && typeof value.header === "string" && typeof value.server === "string") {
        return { header: value.header, kind: "mcp_header", server: value.server };
    }

    return undefined;
};

const asFormat = (value: unknown): SecretFormat | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    return {
        ...(typeof value.prefix === "string" && value.prefix.length > 0 && { prefix: value.prefix }),
        ...(typeof value.minLength === "number" && Number.isSafeInteger(value.minLength) && value.minLength > 0 && { minLength: value.minLength }),
    };
};

/** The secrets the saved call asked for: its `fields`, or the one `use`. `undefined` when the input names no valid destination. */
const askedFields = (input: StoredRequest): AskedField[] | undefined => {
    if (input.fields === undefined) {
        const use = asUse(input.use);

        return use === undefined || invalidSecretUse(use) !== undefined
            ? undefined
            : [{ format: asFormat(input.format), label: typeof input.label === "string" ? input.label.slice(0, SECRET_LABEL_MAX) : "Secret", use }];
    }

    if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > SECRET_FIELDS_MAX || input.use !== undefined) {
        return undefined;
    }

    const names = new Set<string>();
    const fields: AskedField[] = [];

    for (const raw of input.fields as unknown[]) {
        const field = isRecord(raw) ? raw : {};
        const use = asUse(field.use);

        if (
            use === undefined ||
            invalidSecretUse(use) !== undefined ||
            typeof field.name !== "string" ||
            !SECRET_FIELD_NAME_RE.test(field.name) ||
            names.has(field.name)
        ) {
            return undefined;
        }

        names.add(field.name);
        fields.push({
            format: asFormat(field.format),
            label: typeof field.label === "string" ? field.label.slice(0, SECRET_LABEL_MAX) : field.name,
            name: field.name,
            use,
        });
    }

    return fields;
};

/** The destination with the address of the server it names, which must be exactly one of the owner's saved ones. */
const withServerUrl = async (ctx: Pick<MutationCtx, "db">, ownerId: string, use: SecretUse, expectedUrl: string | undefined): Promise<SecretUse> => {
    if (use.kind !== "mcp_header") {
        return use;
    }

    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", ownerId))
        .unique();
    const matches = (preferences?.mcpServers ?? []).filter((server) => server.name === use.server);

    if (matches.length === 0) {
        throw new LunoraError("BAD_REQUEST", `There is no saved MCP server named "${use.server}"; add it in Settings first`);
    }

    if (matches.length > 1) {
        throw new LunoraError("BAD_REQUEST", `More than one saved MCP server is named "${use.server}"; rename one in Settings first`);
    }

    const { url } = matches[0]!;

    // The card showed an address; the value goes to that one or nowhere, never to what the name points at by now.
    if (expectedUrl === undefined || expectedUrl !== url) {
        throw new LunoraError(
            "BAD_REQUEST",
            `The address of the MCP server "${use.server}" changed since this request was shown. Reload the request and check it again`,
            { data: { code: SECRET_SERVER_MOVED } },
        );
    }

    return { ...use, url };
};

export const claimSecretAnswer = async (
    ctx: Pick<MutationCtx, "db">,
    args: {
        approvalId: string;
        callerId: string;
        /** The server address the card displayed; a header save without it, or with one the saved server no longer has, is refused. */
        expectedUrl: string | undefined;
        now: number;
        reply: SecretReply;
        threadId: Id<"threads">;
        unlockProof?: string | null;
    },
): Promise<SecretClaim> => {
    const { approvalId, callerId, expectedUrl, now, reply, threadId, unlockProof } = args;
    const claim = await claimToolApproval(ctx, {
        approvalId,
        callerId,
        decision: reply.kind === "save" ? "approve" : "deny",
        threadId,
        unlockProof,
    });

    if (claim.kind !== "claimed") {
        return claim;
    }

    if (claim.toolName !== REQUEST_SECRET_TOOL_NAME) {
        throw new LunoraError("BAD_REQUEST", "This request is not a secret request");
    }

    if (reply.kind === "decline") {
        return claim;
    }

    // The call's own input names the destination(s): the card showed them, and each value is bound to its own.
    const requested = await findPendingRequestOnLatestTurn(ctx, threadId, approvalId);
    const input = (isRecord(requested?.input) ? requested.input : {}) as StoredRequest;
    const asked = askedFields(input);

    if (asked === undefined) {
        throw new LunoraError("BAD_REQUEST", "This secret request has no valid destination");
    }

    // A continuation runs as the owner, but a consumer spends a reference only in a turn the owner started (`takeRequestedSecret`):
    // a value stored for a collaborator's turn could never be used.
    if (claim.config.startedBy !== claim.ownerId) {
        throw new LunoraError(
            "BAD_REQUEST",
            "Only a reply you started can use a secret, and someone else started this one. Decline it, or ask again in your own message",
        );
    }

    const answers = [{ expectedUrl, value: reply.value }, ...(reply.more ?? [])];

    if (answers.length !== asked.length) {
        throw new LunoraError("BAD_REQUEST", "Provide a value for every field of the request");
    }

    // Every value is checked before the first is stored, so a refusal leaves nothing behind (a throw also rolls the claim back).
    const prepared: { field: AskedField; use: SecretUse; value: string }[] = [];

    for (const [index, field] of asked.entries()) {
        const { expectedUrl: fieldUrl, value: raw } = answers[index]!;
        const value = raw.trim();

        if (value.length === 0 || value.length > secretValueMax(field.use)) {
            throw new LunoraError("BAD_REQUEST", "Provide a value that fits where it is going");
        }

        const problem = secretFormatProblem(value, field.format);

        if (problem !== undefined) {
            // Names the rule, never the value.
            throw new LunoraError(
                "BAD_REQUEST",
                problem === "prefix"
                    ? `The value does not start with "${field.format?.prefix ?? ""}", as the request requires. Check it and try again`
                    : `The value is shorter than the ${field.format?.minLength ?? 0} characters the request requires. Check it and try again`,
                { data: { code: SECRET_FORMAT_INVALID, field: index } },
            );
        }

        if (field.use.kind === "mcp_header" && SECRET_HEADER_VALUE_FORBIDDEN_RE.test(value)) {
            throw new LunoraError("BAD_REQUEST", "A header value cannot contain a line break, a control character or a character above U+00FF");
        }

        prepared.push({ field, use: await withServerUrl(ctx, claim.ownerId, field.use, fieldUrl), value });
    }

    const refs: string[] = [];

    for (const { field, use, value } of prepared) {
        refs.push(
            await storeRequestedSecret(ctx, {
                approvalId,
                label: field.label,
                now,
                ...(claim.config.replyKey !== undefined && { replyKey: claim.config.replyKey }),
                threadId,
                use,
                userId: claim.ownerId,
                value,
            }),
        );
    }

    if (input.fields === undefined) {
        return { ...claim, providerKeySaves: prepared[0]!.use.kind === "provider_key" ? 1 : 0, ref: refs[0]!, use: prepared[0]!.use };
    }

    return {
        ...claim,
        refs: Object.fromEntries(asked.map((field, index) => [field.name!, refs[index]!])),
        providerKeySaves: prepared.filter(({ use }) => use.kind === "provider_key").length,
    };
};

/** What `resumeClaimedRun` gets: the reference for a saved value, a denial for a decline — never the value. */
export const secretResumeArgs = (claim: SecretClaim & { kind: "claimed" }): { answer: string; approved: true } | { approved: false; denyReason: string } => {
    if (claim.refs !== undefined) {
        return { answer: JSON.stringify(claim.refs), approved: true };
    }

    return claim.ref === undefined ? { approved: false, denyReason: SECRET_DECLINED_REASON } : { answer: claim.ref, approved: true };
};
