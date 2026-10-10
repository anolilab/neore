import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../../lib/utilities";
import UserView from "../../user-view";

export interface DeleteAccountDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
}

/** Reads the clock, so it lives outside the component that renders with it. */
const isSessionFresh = (createdAt: Date, freshAge: number): boolean => Date.now() - createdAt.getTime() < freshAge * 1000;

/** `gdpr/deletion-guard.ts` refuses a stale session with `data.code: "SESSION_NOT_FRESH"`. */
const isSessionNotFreshError = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as { data?: { code?: unknown } }).data?.code === "SESSION_NOT_FRESH";

/**
 * Deletion goes through `gdpr_functions.requestAccountDeletion`, which runs the
 * full erasure workflow — better-auth's `deleteUser` is disabled on the backend
 * because it removes only the auth rows. The GDPR procedure takes no password;
 * it requires a fresh session server-side, and this dialog mirrors that check so
 * a stale session is sent to sign out and back in before asking.
 */
const DeleteAccountDialog = ({ classNames, onOpenChange, ...properties }: DeleteAccountDialogProperties) => {
    const { authClient, basePath, freshAge, navigate, toast, viewPaths } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();
    const requestDeletion = useMutation(crpc.gdpr.functions.requestAccountDeletion.mutationOptions());
    // Deleting the account cancels every Team plan it pays for (`teamBillingOnAccountDeletion`).
    const { data: teamPlans } = useQuery({ ...crpc.billing.checkout.getTeamPlansIPay.queryOptions({}), enabled: properties.open === true });

    const { data: sessionData } = useSession(authClient);
    const session = sessionData?.session;
    const user = sessionData?.user;

    const isFresh = session ? isSessionFresh(session.createdAt, freshAge) : false;

    const form = useAppForm({
        defaultValues: {},
        onSubmit: async () => {
            if (!isFresh) {
                navigate(`${basePath}/${viewPaths.SIGN_OUT}`);

                return;
            }

            try {
                await requestDeletion.mutateAsync({});

                toast({
                    message: t`Account deletion started. You will be signed out.`,
                    variant: "success",
                });
                onOpenChange?.(false);
                // The workflow is erasing the account under this session; the
                // sign-out view ends it and clears the local auth state.
                navigate(`${basePath}/${viewPaths.SIGN_OUT}`);
            } catch (error) {
                onOpenChange?.(false);

                // The backend enforces freshness itself; the check above is UX.
                // A refusal (clock skew, a session that aged while the dialog
                // was open) takes the same sign-in-again path.
                if (isSessionNotFreshError(error)) {
                    toast({ message: t`Please sign in again to delete your account.`, variant: "error" });
                    navigate(`${basePath}/${viewPaths.SIGN_OUT}`);

                    return;
                }

                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
    });

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent className={cn("sm:max-w-md", classNames?.dialog?.content)}>
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Delete Account`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {isFresh
                            ? t`This permanently deletes your account and all associated data. It cannot be undone or cancelled.`
                            : t`Your session is not fresh. Please sign out and sign back in to delete your account.`}
                    </DialogDescription>
                </DialogHeader>

                {isFresh && teamPlans && teamPlans.length > 0 && (
                    <Alert variant="destructive">
                        <AlertTitle>{t`Your Team plans will be cancelled`}</AlertTitle>
                        <AlertDescription>
                            <p>{t`You pay for the Team plan of these organizations. Deleting your account cancels it immediately, and their members lose Team features:`}</p>
                            <ul className="mt-1 list-disc pl-4">
                                {teamPlans.map((plan) => (
                                    <li key={plan.organizationId}>{t`${plan.name} (${plural(plan.memberCount, { one: "# member", other: "# members" })})`}</li>
                                ))}
                            </ul>
                        </AlertDescription>
                    </Alert>
                )}

                <Card className={cn("my-2 flex-row p-4", classNames?.cell)}>
                    <UserView user={user} />
                </Card>

                <form.AppForm>
                    <form
                        className="grid gap-6"
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        <DialogFooter className={classNames?.dialog?.footer}>
                            <Button
                                className={cn(classNames?.button, classNames?.secondaryButton)}
                                onClick={() => onOpenChange?.(false)}
                                type="button"
                                variant="secondary"
                            >
                                {t`Cancel`}
                            </Button>

                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => (
                                    <Button
                                        className={cn(classNames?.button, classNames?.destructiveButton)}
                                        disabled={!canSubmit || isSubmitting}
                                        type="submit"
                                        variant="destructive"
                                    >
                                        {isSubmitting && <Loader2 className="animate-spin" />}
                                        {isFresh ? t`Delete Account` : t`Sign Out`}
                                    </Button>
                                )}
                            </form.Subscribe>
                        </DialogFooter>
                    </form>
                </form.AppForm>
            </DialogContent>
        </Dialog>
    );
};

export default DeleteAccountDialog;
