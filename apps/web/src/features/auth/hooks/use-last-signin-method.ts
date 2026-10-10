"use client";

import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import { useEffect, useState } from "react";

interface LastSignInData {
    email?: string;
    method: SignInMethod;
    socialProvider?: string; // Track the specific social provider
    timestamp: number;
}

const STORAGE_KEY = "last-signin-method:v1";

export type SignInMethod = "email" | "username" | "social" | "anonymous";

const useLastSignInMethod = () => {
    const isHydrated = useIsHydrated();
    const [lastSignIn, setLastSignIn] = useState<LastSignInData | null>(null);

    // Load from localStorage on hydration
    useEffect(() => {
        if (!isHydrated) {
            return;
        }

        try {
            const stored = localStorage.getItem(STORAGE_KEY);

            if (stored) {
                const parsed = JSON.parse(stored) as LastSignInData;
                // Only use data that's less than 30 days old
                const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

                if (parsed.timestamp > thirtyDaysAgo) {
                    setLastSignIn(parsed);
                } else {
                    localStorage.removeItem(STORAGE_KEY);
                }
            }
        } catch (error) {
            console.warn("Failed to load last sign-in method from localStorage:", error);
            localStorage.removeItem(STORAGE_KEY);
        }
    }, [isHydrated]);

    const saveLastSignIn = (method: SignInMethod, email?: string, socialProvider?: string) => {
        if (!isHydrated) {
            return;
        }

        // Don't overwrite existing sign-in method with anonymous
        if (method === "anonymous") {
            return;
        }

        try {
            const data: LastSignInData = {
                email,
                method,
                socialProvider,
                timestamp: Date.now(),
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            setLastSignIn(data);
        } catch (error) {
            console.warn("Failed to save last sign-in method to localStorage:", error);
        }
    };

    const clearLastSignIn = () => {
        if (!isHydrated) {
            return;
        }

        try {
            localStorage.removeItem(STORAGE_KEY);
            setLastSignIn(null);
        } catch (error) {
            console.warn("Failed to clear last sign-in method from localStorage:", error);
        }
    };

    return {
        clearLastSignIn,
        isHydrated,
        lastSignIn,
        saveLastSignIn,
    };
};

export default useLastSignInMethod;
