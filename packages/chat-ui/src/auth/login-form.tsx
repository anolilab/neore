import { useLingui } from "@lingui/react/macro";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

import cn from "../utils/cn";

interface LoginFormProps {
    error?: string;
    isLoading?: boolean;
    onSignIn: (email: string, password: string) => Promise<void>;
    onSignInWithGoogle?: () => void;
}

const LoginForm = ({ error, isLoading = false, onSignIn, onSignInWithGoogle }: LoginFormProps) => {
    const { t } = useLingui();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const isDisabled = isLoading || submitting;

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (isDisabled || !email.trim() || !password) {
            return;
        }

        setSubmitting(true);

        try {
            await onSignIn(email.trim(), password);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex w-full flex-col gap-5">
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-50">{t`Sign in`}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t`Enter your credentials to continue`}</p>
            </div>

            {error && (
                <div
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
                    role="alert"
                >
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="login-email">
                        {t`Email`}
                    </label>
                    <input
                        autoComplete="email"
                        className={cn(
                            "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900",
                            "placeholder:text-gray-400",
                            "focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                            "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-50 dark:placeholder:text-gray-500",
                            "dark:focus:border-blue-400 dark:focus:ring-blue-400/20",
                        )}
                        disabled={isDisabled}
                        id="login-email"
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        required
                        type="email"
                        value={email}
                    />
                </div>

                <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="login-password">
                        {t`Password`}
                    </label>
                    <div className="relative">
                        <input
                            autoComplete="current-password"
                            className={cn(
                                "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-10 text-sm text-gray-900",
                                "placeholder:text-gray-400",
                                "focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none",
                                "disabled:cursor-not-allowed disabled:opacity-50",
                                "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-50 dark:placeholder:text-gray-500",
                                "dark:focus:border-blue-400 dark:focus:ring-blue-400/20",
                            )}
                            disabled={isDisabled}
                            id="login-password"
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="••••••••"
                            required
                            type={showPassword ? "text" : "password"}
                            value={password}
                        />
                        <button
                            aria-label={showPassword ? t`Hide password` : t`Show password`}
                            className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                            onClick={() => setShowPassword((previous) => !previous)}
                            tabIndex={-1}
                            type="button"
                        >
                            {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
                        </button>
                    </div>
                </div>

                <button
                    className={cn(
                        "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium",
                        "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800",
                        "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                        "transition-colors",
                    )}
                    disabled={isDisabled || !email.trim() || !password}
                    type="submit"
                >
                    {isDisabled && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
                    {t`Sign In`}
                </button>
            </form>

            {onSignInWithGoogle && (
                <>
                    <div className="flex items-center gap-3">
                        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                        <span className="text-xs text-gray-400">{t`or`}</span>
                        <div className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                    </div>

                    <button
                        className={cn(
                            "flex w-full items-center justify-center gap-2.5 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700",
                            "hover:bg-gray-50 active:bg-gray-100",
                            "focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:outline-none",
                            "disabled:cursor-not-allowed disabled:opacity-60",
                            "dark:hover:bg-gray-750 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200",
                            "transition-colors",
                        )}
                        disabled={isDisabled}
                        onClick={onSignInWithGoogle}
                        type="button"
                    >
                        <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                fill="#4285F4"
                            />
                            <path
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                fill="#34A853"
                            />
                            <path
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                fill="#FBBC05"
                            />
                            <path
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                fill="#EA4335"
                            />
                        </svg>
                        {t`Continue with Google`}
                    </button>
                </>
            )}
        </div>
    );
};

export default LoginForm;
