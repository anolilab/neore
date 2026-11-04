import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";

import useAuthenticate from "@/features/auth/hooks/use-authenticate";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { authClient } from "@/lib/auth/client";
import { seo } from "@/lib/seo";

/**
 * Approve a sign-in started by the `neore` command line (`neore login --device`).
 *
 * The CLI shows a short code; the person opens this page (the link carries the
 * code, or they type it), signs in the normal way and decides. Opening the code
 * while signed in CLAIMS it for this account (better-auth's device-authorization
 * plugin), so only this account can approve or deny it. Approving makes the CLI
 * collect a read-only API key; this page never sees or shows that key.
 *
 * The host name is whatever the requesting machine sent. It is shown as plain
 * text (React escapes it) and reduced to host-name characters by the backend.
 * See `backend/lunora/auth/cli-device-auth.ts`.
 */
interface DeviceSearch {
    user_code?: string;
}

type Decision = "approved" | "denied";

type Problem = "expired" | "invalid" | "keyLimit" | "unavailable";

interface Lookup {
    hostname?: string;
    /** False when another account claimed the code: its details are not shown to this one. */
    isMine: boolean;
    status: "approved" | "denied" | "pending";
}

interface FetchFailure {
    error?: unknown;
}

const CODE_LENGTH = 8;

/** The server ignores case, spaces and dashes; so does the form. */
const normalizeCode = (value: string): string => value.replaceAll(/[^a-z0-9]/giu, "").toUpperCase();

const formatCode = (code: string): string => (code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const problemOf = (failure: object | null | undefined): Problem => {
    const { error } = (failure ?? {}) as FetchFailure;

    if (error === "expired_token") {
        return "expired";
    }

    if (error === "key_limit") {
        return "keyLimit";
    }

    return error === "invalid_request" ? "invalid" : "unavailable";
};

class ProblemError extends Error {
    public readonly problem: Problem;

    public constructor(problem: Problem) {
        super(problem);
        this.problem = problem;
    }
}

const CodeForm = () => {
    const { t } = useLingui();
    const navigate = Route.useNavigate();
    const [typed, setTyped] = useState("");

    const submit = (event: FormEvent) => {
        event.preventDefault();

        const code = normalizeCode(typed);

        if (code.length > 0) {
            navigate({ search: { user_code: code } }).catch(() => undefined);
        }
    };

    return (
        <form className="flex flex-col gap-4" onSubmit={submit}>
            <h1 className="text-center text-xl font-semibold">{t`Sign in the command line`}</h1>
            <p className="text-center text-sm text-gray-700">{t`Enter the code that \`neore login --device\` shows in your terminal.`}</p>
            <div className="flex flex-col gap-2">
                <Label htmlFor="device-code">{t`Code`}</Label>
                <Input
                    autoCapitalize="characters"
                    autoComplete="off"
                    autoCorrect="off"
                    id="device-code"
                    maxLength={16}
                    onChange={(event) => setTyped(event.target.value)}
                    spellCheck={false}
                    value={typed}
                />
            </div>
            <Button disabled={normalizeCode(typed).length === 0} type="submit">
                {t`Continue`}
            </Button>
        </form>
    );
};

const ProblemMessage = ({ problem }: { problem: Problem }) => {
    const { t } = useLingui();
    const messages: Record<Problem, string> = {
        expired: t`This code has expired. Run \`neore login --device\` again to get a new one.`,
        invalid: t`This code is not valid, or it was already used. Run \`neore login --device\` again to get a new one.`,
        keyLimit: t`Your account already has the maximum number of API keys, so the command line was not signed in. Revoke one in Settings, then run \`neore login --device\` again.`,
        unavailable: t`The code could not be checked right now. Try again in a moment.`,
    };

    return (
        <div className="flex flex-col gap-4 text-center">
            <p className="text-sm text-red-600" role="alert">
                {messages[problem]}
            </p>
            <a className="text-sm font-medium underline underline-offset-4" href="/auth/device">
                {t`Enter a different code`}
            </a>
        </div>
    );
};

const Review = ({ email, lookup, userCode }: { email: string; lookup: Lookup; userCode: string }) => {
    const { t } = useLingui();
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [problem, setProblem] = useState<Problem>();
    const [decision, setDecision] = useState<Decision>();

    if (problem) {
        return <ProblemMessage problem={problem} />;
    }

    if (decision) {
        return (
            <p className="text-center text-sm text-gray-700" role="status">
                {decision === "approved"
                    ? t`Approved. Return to your terminal: the command line is signed in. You can close this tab.`
                    : t`Denied. The command line was not signed in. You can close this tab.`}
            </p>
        );
    }

    if (!lookup.isMine) {
        return (
            <p className="text-center text-sm text-red-600" role="alert">
                {t`This code was opened with a different account. Sign in with that account, or run \`neore login --device\` again.`}
            </p>
        );
    }

    if (lookup.status !== "pending") {
        return (
            <p className="text-center text-sm text-gray-700" role="status">
                {t`This code has already been answered.`}
            </p>
        );
    }

    const decide = async (next: Decision) => {
        setError(undefined);
        setIsBusy(true);

        // A request that rejects (offline, reset, aborted) is the same retryable "unavailable" as a 5xx.
        const result = await authClient
            .$fetch(next === "approved" ? "/device/approve" : "/device/deny", { body: { userCode }, method: "POST" })
            .catch(() => null);

        setIsBusy(false);

        const failure = result?.error;
        let reason: Problem | undefined = failure ? problemOf(failure) : undefined;

        if (!result) {
            reason = "unavailable";
        }

        if (reason === "unavailable") {
            setError(t`That did not go through. Try again.`);
        } else if (reason) {
            setProblem(reason);
        } else {
            setDecision(next);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <h1 className="text-center text-xl font-semibold">{t`Sign in the command line?`}</h1>
            <p className="text-center text-sm text-gray-700">
                {t`The command line on the computer below will be signed in as ${email}, with read-only access to your chats, skills, tasks, knowledge and memories through the API. It gets its own API key, which you can revoke in Settings.`}
            </p>
            <dl className="flex flex-col gap-1 rounded-md bg-gray-100 p-3 text-sm">
                <div className="flex justify-between gap-4">
                    <dt className="text-gray-600">{t`Computer`}</dt>
                    <dd className="font-medium break-all">{lookup.hostname ?? t`unknown`}</dd>
                </div>
                <div className="flex justify-between gap-4">
                    <dt className="text-gray-600">{t`Code`}</dt>
                    <dd className="font-mono font-medium">{formatCode(userCode)}</dd>
                </div>
            </dl>
            <p className="text-center text-sm text-gray-700">{t`Only continue if you started this just now by running \`neore login --device\`, and the code above matches the one in your terminal.`}</p>
            {error && (
                <p className="text-center text-sm text-red-600" role="alert">
                    {error}
                </p>
            )}
            <div className="flex justify-center gap-2">
                <Button
                    disabled={isBusy}
                    onClick={() => {
                        decide("denied").catch(() => undefined);
                    }}
                    type="button"
                    variant="outline"
                >
                    {t`Deny`}
                </Button>
                <Button
                    disabled={isBusy}
                    onClick={() => {
                        decide("approved").catch(() => undefined);
                    }}
                    type="button"
                >
                    {isBusy ? t`Working…` : t`Approve`}
                </Button>
            </div>
        </div>
    );
};

const DeviceApproval = () => {
    const { t } = useLingui();
    const { user_code: rawCode } = Route.useSearch();
    const userCode = rawCode ? normalizeCode(rawCode) : undefined;
    const { data, isPending } = useAuthenticate();
    const { isAnonymous } = useIsAnonymous();
    const userId = data?.user?.id;

    // Opening the code while signed in claims it for this account, so it runs once per code and account.
    const { data: lookup, error: lookupError } = useQuery({
        enabled: Boolean(userCode && userId && !isAnonymous),
        gcTime: 0,
        queryFn: async (): Promise<Lookup> => {
            const { data: body, error: failure } = await authClient.$fetch<{ client_id?: string; hostname?: string; status?: Lookup["status"] }>("/device", {
                method: "GET",
                query: { user_code: userCode },
            });

            if (failure || !body) {
                throw new ProblemError(problemOf(failure));
            }

            return { hostname: asString(body.hostname), isMine: body.client_id !== undefined, status: body.status ?? "pending" };
        },
        queryKey: ["device-code", userCode, userId],
        retry: false,
        staleTime: Infinity,
    });

    if (isPending || !data?.user) {
        return (
            <p className="text-center text-sm text-gray-600" role="status">
                {t`Loading…`}
            </p>
        );
    }

    if (isAnonymous) {
        const here = globalThis.location.href.replace(globalThis.location.origin, "");

        return (
            <div className="flex flex-col gap-4 text-center">
                <p className="text-sm text-gray-700">{t`You are browsing as a guest. Sign in with your account to sign in the command line.`}</p>
                <a className="text-sm font-medium underline underline-offset-4" href={`/auth/sign-in?redirectTo=${encodeURIComponent(here)}`}>
                    {t`Sign in`}
                </a>
            </div>
        );
    }

    if (!userCode) {
        return <CodeForm />;
    }

    if (lookupError) {
        return <ProblemMessage problem={lookupError instanceof ProblemError ? lookupError.problem : "unavailable"} />;
    }

    if (!lookup) {
        return (
            <p className="text-center text-sm text-gray-600" role="status">
                {t`Checking the code…`}
            </p>
        );
    }

    return <Review email={data.user.email} lookup={lookup} userCode={userCode} />;
};

export const Route = createFileRoute("/auth/device")({
    component: DeviceApproval,
    validateSearch: (search: Record<string, unknown>): DeviceSearch => {
        return { user_code: asString(search.user_code) };
    },
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Sign in the command line`) }),
        };
    },
});
