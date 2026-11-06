"use client";

import { useNavigate } from "@tanstack/react-router";
import type { FC, ReactNode } from "react";
import { useEffect } from "react";

/**
 * Sends a signed-out visitor to sign in, and back here afterwards (`redirectTo`,
 * read by `use-success-transition.ts`). For pages that have nothing to show
 * without an account while registration is invite-only. Renders `children`
 * (a loading state) until the navigation lands.
 */
const SignInRedirect: FC<{ children?: ReactNode }> = ({ children = null }) => {
    const navigate = useNavigate();

    useEffect(() => {
        const { hash, pathname, search } = globalThis.location;

        void navigate({ href: `/auth/sign-in?redirectTo=${encodeURIComponent(`${pathname}${search}${hash}`)}`, replace: true });
    }, [navigate]);

    return children;
};

export default SignInRedirect;
