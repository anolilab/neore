"use client";

import { useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import type { FC } from "react";
import { useEffect, useRef } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

import AuthCard from "./auth-card";

interface LoginModalProperties {
    onOpenChange: (open: boolean) => void;
    open: boolean;
}

const LoginModal: FC<LoginModalProperties> = ({ onOpenChange, open }) => {
    const { t } = useLingui();
    const { isAnonymous, user } = useIsAnonymous();

    // Track whether the user was unauthenticated: either no session at all, or anonymous.
    // We need to cover both cases because the app can run with or without anonymous sessions.
    const wasUnauthenticatedRef = useRef(!user || isAnonymous);

    // Auto-close modal when user successfully authenticates with a real account
    useEffect(() => {
        const isRealUser = !!user && !isAnonymous;

        if (wasUnauthenticatedRef.current && isRealUser && open) {
            onOpenChange(false);
        }

        wasUnauthenticatedRef.current = !user || isAnonymous;
    }, [user, isAnonymous, open, onOpenChange]);

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent bottomStickOnMobile={false} className="w-full max-w-sm p-0 sm:max-w-[420px]" showCloseButton>
                <DialogHeader className="sr-only">
                    <DialogTitle>{t`Login`}</DialogTitle>
                    <DialogDescription>{t`Sign in to your account`}</DialogDescription>
                </DialogHeader>
                <AuthCard
                    classNames={{
                        base: "border-0 shadow-none ring-0 bg-transparent",
                    }}
                    view="SIGN_IN"
                />
            </DialogContent>
        </Dialog>
    );
};

export default LoginModal;
