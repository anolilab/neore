"use client";

import { useIsRestoring } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

const AuthCallback = ({ redirectTo }: { redirectTo?: string }) => {
    const { persistClient } = useAuth();

    const isRestoring = useIsRestoring();
    const isRedirecting = useRef(false);

    const { onSuccess } = useOnSuccessTransition({ redirectTo });

    useEffect(() => {
        if (isRedirecting.current) {
            return;
        }

        if (!persistClient) {
            isRedirecting.current = true;
            onSuccess();

            return;
        }

        if (isRestoring) {
            return;
        }

        isRedirecting.current = true;
        onSuccess();
    }, [isRestoring, persistClient, onSuccess]);

    return <Loader2 className="animate-spin" />;
};

export default AuthCallback;
