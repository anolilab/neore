import type { FC, PropsWithChildren } from "react";

import { isSignUpOpen } from "@/features/auth/lib/sign-up-open";
import env from "@/lib/env";

/** Renders its children only while registration is open (not invite-only). */
const SignUpOpenOnly: FC<PropsWithChildren> = ({ children }) => (isSignUpOpen(env.VITE_SIGNUP_INVITE_ONLY) ? children : null);

export default SignUpOpenOnly;
