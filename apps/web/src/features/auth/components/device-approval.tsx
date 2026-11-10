import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode, Ref } from "react";
import { useEffect, useRef, useState } from "react";

import { DeviceCodeDetails, DeviceCodeForm, MachineCodeDetails, normalizeCode } from "@/features/auth/components/device-code-parts";
import useAuthenticate from "@/features/auth/hooks/use-authenticate";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { authClient } from "@/lib/auth/client";
import type { DeviceProblem } from "@/lib/auth/device-problem";
import { problemOf } from "@/lib/auth/device-problem";

/**
 * Approve a code shown by a terminal: a sign-in started by the `neore` command line (`neore login --device`), or
 * the pairing of a headless machine (`neore-host pair`, client `neore-host`). The two ask for different things, so
 * the consent text follows the kind of code; only the lookup tells them apart.
 *
 * The CLI shows a short code; the person opens the page (the link carries the
 * code, or they type it), signs in the normal way and decides. Opening the code
 * while signed in CLAIMS it for this account (better-auth's device-authorization
 * plugin), so only this account can approve or deny it. Approving makes the CLI
 * collect a read-only API key; this page never sees or shows that key. Approving a machine code makes the machine
 * a device of this account that the assistant can run tools on, so it is worded as that, never as an API key.
 *
 * The host name is whatever the requesting machine sent. It is shown as plain
 * text (React escapes it) and reduced to host-name characters by the backend.
 * See `backend/lunora/auth/cli-device-auth.ts`.
 */
type Problem = DeviceProblem | "notMine" | "unsupported";

type Decision = "approved" | "denied";

interface Lookup {
    /** `neore-host`: a headless machine pairing itself as a device. Anything else is the command line's sign-in. */
    clientId?: string;
    hostname?: string;
    /** False when another account claimed the code: its details are not shown to this one. */
    isMine: boolean;
    /** Machine codes only: what the machine says it is (untrusted, shown as text). */
    platform?: string;
    status: "approved" | "denied" | "pending";
    /** Machine codes only: where the machine says it will keep its device secret. */
    storage?: string;
}

const CLI_CLIENT_ID = "neore-cli";

const HOST_CLIENT_ID = "neore-host";

const asText = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

const CODE_LENGTH = 8;

const formatCode = (code: string): string => (code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

class ProblemError extends Error {
    public readonly problem: Problem;

    public constructor(problem: Problem) {
        super(problem);
        this.problem = problem;
    }
}

const Heading = ({ children, headingRef }: { children: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) => (
    <h1 className="text-center text-xl font-semibold outline-none" ref={headingRef} tabIndex={-1}>
        {children}
    </h1>
);

const ProblemMessage = ({ headingRef, onRetry, problem }: { headingRef?: Ref<HTMLHeadingElement>; onRetry?: () => void; problem: Problem }) => {
    const { t } = useLingui();
    const messages: Record<Problem, string> = {
        deviceLimit: t`This account already has the maximum number of paired devices. Remove one in Settings, then run \`neore-host pair\` again.`,
        expired: t`This code has expired. Run \`neore login --device\` or \`neore-host pair\` again to get a new one.`,
        impersonating: t`You are signed in as another person (an admin session). Sign in as yourself to approve this code.`,
        invalid: t`This code is not valid, or it was already used. Run \`neore login --device\` or \`neore-host pair\` again to get a new one.`,
        keyLimit: t`Your account already has the maximum number of API keys, so the command line was not signed in. Revoke one in Settings, then run \`neore login --device\` again.`,
        notMine: t`This code was opened with a different account. Sign in with that account, or run \`neore login --device\` or \`neore-host pair\` again.`,
        rateLimited: t`Too many attempts. Wait a few seconds, then try again.`,
        unavailable: t`The code could not be checked right now. Try again in a moment.`,
        unsupported: t`This code can't be approved here.`,
    };
    const isRetryable = onRetry !== undefined && (problem === "unavailable" || problem === "rateLimited");

    return (
        <div className="flex flex-col gap-4 text-center">
            <Heading headingRef={headingRef}>{t`Approve a code`}</Heading>
            <p className="text-sm text-red-600" role="alert">
                {messages[problem]}
            </p>
            {isRetryable && (
                <Button onClick={onRetry} type="button" variant="outline">
                    {t`Try again`}
                </Button>
            )}
            <a className="text-sm font-medium underline underline-offset-4" href="/auth/device">
                {t`Enter a different code`}
            </a>
        </div>
    );
};

interface ReviewProps {
    email: string;
    lookup: Lookup;
    /** Reads the code again; resolves with its status, or undefined when it could not be read. */
    onRefresh: () => Promise<Lookup["status"] | undefined>;
    userCode: string;
}

const Review = ({ email, lookup, onRefresh, userCode }: ReviewProps) => {
    const { t } = useLingui();
    const [pending, setPending] = useState<Decision>();
    const [error, setError] = useState<string>();
    const [problem, setProblem] = useState<Problem>();
    const [decision, setDecision] = useState<Decision>();
    const resultHeading = useRef<HTMLHeadingElement>(null);
    const hasActed = useRef(false);
    const isBusy = pending !== undefined;
    const busyMessages: Record<Decision, string> = { approved: t`Approving…`, denied: t`Denying…` };
    const isHost = lookup.clientId === HOST_CLIENT_ID;
    const outcomes: Record<Decision, { detail: string; title: string }> = isHost
        ? {
              approved: {
                  detail: t`Return to the machine: it finishes pairing on its next check and says so in its terminal. Then choose projects for it in Settings, or the assistant won't use it in any chat. You can close this tab.`,
                  title: t`Approved`,
              },
              denied: { detail: t`The machine was not paired. You can close this tab.`, title: t`Denied` },
          }
        : {
              approved: { detail: t`Return to your terminal: the command line is signed in. You can close this tab.`, title: t`Approved` },
              denied: { detail: t`The command line was not signed in. You can close this tab.`, title: t`Denied` },
          };

    // Whatever replaces the buttons that had focus (the outcome, a refusal, "already answered") takes focus.
    useEffect(() => {
        if (hasActed.current) {
            resultHeading.current?.focus();
        }
    }, [decision, problem, lookup.status]);

    const decide = async (next: Decision) => {
        hasActed.current = true;
        setError(undefined);
        setPending(next);

        // A request that rejects (offline, reset, aborted) is the same retryable "unavailable" as a 5xx.
        const result = await authClient
            .$fetch(next === "approved" ? "/device/approve" : "/device/deny", { body: { userCode }, method: "POST" })
            .catch(() => null);

        let reason: Problem | undefined = result?.error ? problemOf(result.error) : undefined;

        if (!result) {
            reason = "unavailable";
        }

        // Here a 403 is the plugin refusing someone who did not open the code (or an admin session).
        if (reason === "impersonating") {
            reason = "notMine";
        }

        // The buttons stay disabled until the re-read below settles, so a second decision cannot overlap it.
        const status = reason === "invalid" ? await onRefresh() : undefined;

        setPending(undefined);

        if (reason === "unavailable" || reason === "rateLimited") {
            setError(reason === "rateLimited" ? t`Too many attempts. Wait a few seconds, then try again.` : t`That did not go through. Try again.`);
        } else if (reason === "invalid") {
            // Already processed (a retry after the answer got through) is not the same as invalid: look again.
            if (status === "pending") {
                setProblem(reason);
            }
        } else if (reason) {
            setProblem(reason);
        } else {
            setDecision(next);
        }
    };

    let body: ReactNode;

    if (problem) {
        body = <ProblemMessage headingRef={resultHeading} problem={problem} />;
    } else if (decision) {
        body = (
            <div className="flex flex-col gap-4 text-center">
                <Heading headingRef={resultHeading}>{outcomes[decision].title}</Heading>
                <p className="text-sm text-gray-700">{outcomes[decision].detail}</p>
            </div>
        );
    } else if (!lookup.isMine) {
        body = <ProblemMessage problem="notMine" />;
    } else if (lookup.clientId !== CLI_CLIENT_ID && lookup.clientId !== HOST_CLIENT_ID) {
        // Neither consent is right for a client this page does not know: say so, with no buttons.
        body = <ProblemMessage headingRef={resultHeading} problem="unsupported" />;
    } else if (lookup.status === "pending") {
        body = (
            <div className="flex flex-col gap-4">
                <Heading>{isHost ? t`Pair this machine?` : t`Sign in the command line?`}</Heading>
                {isHost ? (
                    <>
                        <p className="text-center text-sm text-gray-700">
                            {t`The machine below will become a device of ${email}. Until you revoke it in Settings, the assistant can run tools on it in the chats of the projects you choose for it there, and you can start coding agents on it yourself. The assistant won't use it in any chat until you choose projects. Its device secret goes only to that machine, never to this page.`}
                        </p>
                        <MachineCodeDetails code={formatCode(userCode)} hostname={lookup.hostname} platform={lookup.platform} storage={lookup.storage} />
                    </>
                ) : (
                    <>
                        <p className="text-center text-sm text-gray-700">
                            {t`The command line on the computer below will be signed in as ${email}, with read-only access to your chats, skills, tasks, knowledge and memories through the API. It gets its own API key, which you can revoke in Settings.`}
                        </p>
                        <DeviceCodeDetails code={formatCode(userCode)} hostname={lookup.hostname} />
                    </>
                )}
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
                        {pending === "denied" ? t`Working…` : t`Deny`}
                    </Button>
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            decide("approved").catch(() => undefined);
                        }}
                        type="button"
                    >
                        {pending === "approved" ? t`Working…` : t`Approve`}
                    </Button>
                </div>
            </div>
        );
    } else {
        body = (
            <div className="flex flex-col gap-4 text-center">
                <Heading headingRef={resultHeading}>{t`Approve a code`}</Heading>
                <p className="text-sm text-gray-700">{t`This code has already been answered.`}</p>
            </div>
        );
    }

    // One live region, mounted for the whole page: it announces the busy text, then the outcome.
    let liveText = "";

    if (pending) {
        liveText = busyMessages[pending];
    } else if (decision) {
        liveText = `${outcomes[decision].title}. ${outcomes[decision].detail}`;
    } else if (!problem && lookup.isMine && lookup.status !== "pending") {
        liveText = t`This code has already been answered.`;
    }

    return (
        <>
            <p className="sr-only" role="status">
                {liveText}
            </p>
            {body}
        </>
    );
};

export const DeviceApproval = ({ onCode, rawCode }: { onCode: (code: string) => void; rawCode: string | undefined }) => {
    const { t } = useLingui();
    const userCode = rawCode ? normalizeCode(rawCode) : undefined;
    const { data, error: sessionError, isPending, refetch } = useAuthenticate();
    const { isAnonymous } = useIsAnonymous();
    const userId = data?.user?.id;
    const isRereading = useRef(false);

    // Opening the code while signed in claims it for this account, so it runs once per code and account.
    const {
        data: lookup,
        error: lookupError,
        refetch: refetchLookup,
    } = useQuery({
        enabled: Boolean(userCode && userId && !isAnonymous),
        gcTime: 0,
        queryFn: async (): Promise<Lookup> => {
            const { data: body, error: failure } = await authClient.$fetch<{
                client_id?: string;
                hostname?: string;
                platform?: string;
                status?: Lookup["status"];
                storage?: string;
            }>("/device", {
                method: "GET",
                query: { user_code: userCode },
            });

            if (failure || !body) {
                throw new ProblemError(problemOf(failure));
            }

            return {
                clientId: body.client_id,
                hostname: body.hostname || undefined,
                isMine: body.client_id !== undefined,
                platform: asText(body.platform),
                status: body.status ?? "pending",
                storage: asText(body.storage),
            };
        },
        queryKey: ["device-code", userCode, userId],
        retry: false,
        staleTime: Infinity,
    });

    // A failed session read is not "still loading": say so and offer a retry (the hook does not redirect on it).
    if (sessionError && !data?.user) {
        return (
            <div className="flex flex-col gap-4 text-center">
                <Heading>{t`Approve a code`}</Heading>
                <p className="text-sm text-red-600" role="alert">
                    {t`We could not check that you are signed in. Try again in a moment.`}
                </p>
                <Button
                    onClick={() => {
                        refetch();
                    }}
                    type="button"
                    variant="outline"
                >
                    {t`Try again`}
                </Button>
            </div>
        );
    }

    if (isPending || !data?.user) {
        return (
            <div className="flex flex-col gap-4">
                <Heading>{t`Approve a code`}</Heading>
                <p className="text-center text-sm text-gray-600" role="status">
                    {t`Loading…`}
                </p>
            </div>
        );
    }

    if (isAnonymous) {
        const here = globalThis.location.href.replace(globalThis.location.origin, "");

        return (
            <div className="flex flex-col gap-4 text-center">
                <Heading>{t`Approve a code`}</Heading>
                <p className="text-sm text-gray-700">{t`You are browsing as a guest. Sign in with your account to approve this code.`}</p>
                <a className="text-sm font-medium underline underline-offset-4" href={`/auth/sign-in?redirectTo=${encodeURIComponent(here)}`}>
                    {t`Sign in`}
                </a>
            </div>
        );
    }

    if (!userCode) {
        return <DeviceCodeForm onCode={onCode} />;
    }

    if (lookupError) {
        return (
            <ProblemMessage
                headingRef={(node) => {
                    // A failed re-read after Approve or Deny replaces the buttons that had focus.
                    if (!node || !isRereading.current) {
                        return;
                    }

                    isRereading.current = false;
                    node.focus();
                }}
                onRetry={() => {
                    refetchLookup().catch(() => undefined);
                }}
                problem={lookupError instanceof ProblemError ? lookupError.problem : "unavailable"}
            />
        );
    }

    if (!lookup) {
        return (
            <div className="flex flex-col gap-4">
                <Heading>{t`Approve a code`}</Heading>
                <p className="text-center text-sm text-gray-600" role="status">
                    {t`Checking the code…`}
                </p>
            </div>
        );
    }

    const refresh = async (): Promise<Lookup["status"] | undefined> => {
        isRereading.current = true;

        const refreshed = await refetchLookup();

        isRereading.current = refreshed.isError;

        return refreshed.data?.status;
    };

    return <Review email={data.user.email} lookup={lookup} onRefresh={refresh} userCode={userCode} />;
};
