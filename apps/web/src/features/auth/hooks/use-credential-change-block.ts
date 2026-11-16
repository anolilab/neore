import { useLingui } from "@lingui/react/macro";

import { useImpersonationState } from "@/features/admin/hooks/use-is-impersonating";

export interface CredentialChangeBlock {
    blocked: boolean;
    /** Said only when an admin is known to act as this account; while that is unknown the control is just disabled. */
    reason: string | undefined;
}

/**
 * Adding a key, passkey, password, address or linked sign-in is refused while an admin acts as the account
 * (403 `CREDENTIAL_WHILE_IMPERSONATING`, `backend/lunora/auth/impersonation-credential-guard.ts`), so the controls
 * stay disabled until the session shows it is the account's own.
 */
const useCredentialChangeBlock = (): CredentialChangeBlock => {
    const { t } = useLingui();
    const state = useImpersonationState();

    return {
        blocked: state !== "self",
        reason: state === "impersonating" ? t`Sign in as yourself to change this. It can't be changed while impersonating.` : undefined,
    };
};

export default useCredentialChangeBlock;
