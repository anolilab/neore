import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Link } from "@tanstack/react-router";
import { ArrowRight, LogIn, MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

const NAV_LINKS: ReadonlyArray<{ icon: typeof MessageSquare; label: MessageDescriptor; to: "/auth/sign-in" | "/chat" | "/models" }> = [
    { icon: MessageSquare, label: msg`New chat`, to: "/chat" },
    { icon: Sparkles, label: msg`Models`, to: "/models" },
    { icon: LogIn, label: msg`Sign in`, to: "/auth/sign-in" },
];

const NotFound = () => {
    const { i18n } = useLingui();
    const [glitchActive, setGlitchActive] = useState(false);

    useEffect(() => {
        let resetTimeout: ReturnType<typeof setTimeout> | undefined;

        const trigger = () => {
            setGlitchActive(true);
            resetTimeout = setTimeout(setGlitchActive, 180, false);
        };

        // Initial glitch shortly after mount
        const initialDelay = setTimeout(trigger, 800);
        const interval = setInterval(trigger, 4500);

        return () => {
            clearTimeout(initialDelay);
            clearInterval(interval);

            if (resetTimeout !== undefined) {
                clearTimeout(resetTimeout);
            }
        };
    }, []);

    return (
        <div className="relative flex min-h-svh w-full items-center justify-center overflow-hidden" style={{ backgroundColor: "#191919" }}>
            {/* Dot grid background */}
            <div
                className="absolute inset-0"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(202,255,0,0.12) 1px, transparent 1px)",
                    backgroundSize: "40px 40px",
                    maskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 100%)",
                    WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 100%)",
                }}
            />

            {/* Ambient lime glow behind number */}
            <div
                className="pointer-events-none absolute"
                style={{
                    background: "radial-gradient(ellipse at center, rgba(202,255,0,0.06) 0%, transparent 70%)",
                    height: "400px",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -65%)",
                    width: "600px",
                }}
            />

            {/* Main content */}
            <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
                {/* Pixel 404 */}
                <div className="animate-in fade-in slide-in-from-bottom-8 fill-mode-both relative duration-700 ease-out select-none">
                    {/* Primary number */}
                    <span
                        className="block leading-none font-black"
                        style={{
                            color: "#caff00",
                            fontFamily: '"Geist Pixel Square", "Geist Variable", monospace',
                            fontSize: "clamp(96px, 20vw, 192px)",
                            textShadow: glitchActive ? "5px 0 #ff0066, -5px 0 #00ddff" : "0 0 60px rgba(202,255,0,0.35), 0 0 120px rgba(202,255,0,0.12)",
                            transform: glitchActive ? "translateX(2px)" : "none",
                            transition: glitchActive ? "none" : "text-shadow 0.4s ease",
                        }}
                    >
                        404
                    </span>

                    {/* Glitch — red slice */}
                    {glitchActive && (
                        <>
                            <span
                                aria-hidden
                                className="pointer-events-none absolute inset-0 block leading-none font-black"
                                style={{
                                    clipPath: "polygon(0 18%, 100% 18%, 100% 36%, 0 36%)",
                                    color: "#ff0066",
                                    fontFamily: '"Geist Pixel Square", "Geist Variable", monospace',
                                    fontSize: "clamp(96px, 20vw, 192px)",
                                    opacity: 0.85,
                                    transform: "translateX(-5px)",
                                }}
                            >
                                404
                            </span>
                            {/* Glitch — cyan slice */}
                            <span
                                aria-hidden
                                className="pointer-events-none absolute inset-0 block leading-none font-black"
                                style={{
                                    clipPath: "polygon(0 62%, 100% 62%, 100% 80%, 0 80%)",
                                    color: "#00ddff",
                                    fontFamily: '"Geist Pixel Square", "Geist Variable", monospace',
                                    fontSize: "clamp(96px, 20vw, 192px)",
                                    opacity: 0.85,
                                    transform: "translateX(5px)",
                                }}
                            >
                                404
                            </span>
                        </>
                    )}
                </div>

                {/* Thin separator */}
                <div className="animate-in fade-in zoom-in-0 fill-mode-both h-px w-40 origin-center bg-[#caff00]/35 delay-400 duration-550" />

                {/* Text */}
                <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col items-center gap-2 delay-500 duration-500">
                    <p className="text-xl font-semibold tracking-tight" style={{ color: "#f2f2f2", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>Page not found</Trans>
                    </p>
                    <p className="max-w-xs text-sm leading-relaxed" style={{ color: "#6b6b6b", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>This page doesn&apos;t exist or may have been moved.</Trans>
                    </p>
                </div>

                {/* Navigation links */}
                <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col items-center gap-3 delay-650 duration-500">
                    <p
                        className="text-xs tracking-widest uppercase"
                        style={{ color: "#3c3c3c", fontFamily: '"Geist Variable", sans-serif', letterSpacing: "0.15em" }}
                    >
                        <Trans>Quick navigation</Trans>
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                        {NAV_LINKS.map(({ icon: Icon, label, to }) => (
                            <Link
                                className="group flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors duration-200"
                                key={to}
                                onMouseEnter={(e) => {
                                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(202,255,0,0.4)";
                                    (e.currentTarget as HTMLElement).style.color = "#f2f2f2";
                                    (e.currentTarget as HTMLElement).style.backgroundColor = "rgba(202,255,0,0.04)";
                                }}
                                onMouseLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.borderColor = "rgba(202,255,0,0.12)";
                                    (e.currentTarget as HTMLElement).style.color = "#6b6b6b";
                                    (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                                }}
                                style={{
                                    borderColor: "rgba(202,255,0,0.12)",
                                    color: "#6b6b6b",
                                    fontFamily: '"Geist Variable", sans-serif',
                                }}
                                to={to}
                            >
                                <Icon size={14} />
                                <span>{i18n._(label)}</span>
                                <ArrowRight className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" size={12} />
                            </Link>
                        ))}
                    </div>
                </div>

                {/* Divider */}
                <div className="animate-in fade-in fill-mode-both flex w-48 items-center gap-3 delay-800 duration-400">
                    <div className="h-px flex-1" style={{ backgroundColor: "rgba(202,255,0,0.08)" }} />
                    <span className="text-xs" style={{ color: "#3c3c3c", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>or</Trans>
                    </span>
                    <div className="h-px flex-1" style={{ backgroundColor: "rgba(202,255,0,0.08)" }} />
                </div>

                {/* Primary CTA */}
                <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both delay-900 duration-500">
                    {/* A link styled as a button: it navigates, so it keeps link semantics. */}
                    <Link className={buttonVariants()} to="/">
                        <Trans>Return home</Trans>
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default NotFound;
