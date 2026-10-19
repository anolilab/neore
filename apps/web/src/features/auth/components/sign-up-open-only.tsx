import type { FC, PropsWithChildren } from "react";

import { isSignUpOpen } from "@/features/auth/lib/sign-up-open";
import env from "@/lib/env";

/**
 * Renders its children only while registration is open (not invite-only). Pass
 * `enabled={false}` for a link that does not need an account, such as `/chat`,
 * which browses anonymously.
 */
const SignUpOpenOnly: FC<PropsWithChildren<{ enabled?: boolean }>> = ({ children, enabled = true }) =>
    !enabled || isSignUpOpen(env.VITE_SIGNUP_INVITE_ONLY) ? children : null;

export default SignUpOpenOnly;
