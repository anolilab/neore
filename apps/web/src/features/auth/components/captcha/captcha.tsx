import HCaptchaWidget from "@hcaptcha/react-hcaptcha";
import { Turnstile } from "@marsidev/react-turnstile";
import { useTheme } from "next-themes";
import type { RefObject } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";

// Default captcha endpoints
const DEFAULT_CAPTCHA_ENDPOINTS = ["/sign-up/email", "/sign-in/email", "/forget-password"];

interface CaptchaProperties {
    action?: string; // Optional action to check if it's in the endpoints list
    ref: RefObject<any>;
}

const Captcha = ({ action, ref }: CaptchaProperties) => {
    const { captcha } = useAuth();
    const { resolvedTheme } = useTheme();

    if (!captcha) {
        return null;
    }

    // If action is provided, check if it's in the list of captcha-enabled endpoints
    if (action) {
        const endpoints = captcha.endpoints || DEFAULT_CAPTCHA_ENDPOINTS;

        if (!endpoints.includes(action)) {
            return null;
        }
    }

    const theme = resolvedTheme === "dark" ? "dark" : "light";

    const isShowTurnstile = captcha.provider === "cloudflare-turnstile";

    const isShowHCaptcha = captcha.provider === "hcaptcha";

    return (
        <>
            {isShowTurnstile && (
                <Turnstile
                    className="mx-auto"
                    options={{
                        size: "flexible",
                        theme,
                    }}
                    ref={ref}
                    siteKey={captcha.siteKey}
                />
            )}
            {isShowHCaptcha && (
                <div className="mx-auto">
                    <HCaptchaWidget ref={ref} sitekey={captcha.siteKey} theme={theme} />
                </div>
            )}
        </>
    );
};

export default Captcha;
