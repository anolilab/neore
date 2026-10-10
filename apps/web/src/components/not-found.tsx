import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Link } from "@tanstack/react-router";
import { ArrowRight, LogIn, MessageSquare, Sparkles } from "lucide-react";
import { motion } from "motion/react";
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
                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="relative select-none"
                    initial={{ opacity: 0, y: 32 }}
                    transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                >
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
                </motion.div>

                {/* Thin separator */}
                <motion.div
                    animate={{ opacity: 0.35, scaleX: 1 }}
                    className="h-px w-40 origin-center"
                    initial={{ opacity: 0, scaleX: 0 }}
                    style={{ backgroundColor: "#caff00" }}
                    transition={{ delay: 0.4, duration: 0.55 }}
                />

                {/* Text */}
                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center gap-2"
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ delay: 0.5, duration: 0.5 }}
                >
                    <p className="text-xl font-semibold tracking-tight" style={{ color: "#f2f2f2", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>Page not found</Trans>
                    </p>
                    <p className="max-w-xs text-sm leading-relaxed" style={{ color: "#6b6b6b", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>This page doesn&apos;t exist or may have been moved.</Trans>
                    </p>
                </motion.div>

                {/* Navigation links */}
                <motion.div
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col items-center gap-3"
                    initial={{ opacity: 0, y: 10 }}
                    transition={{ delay: 0.65, duration: 0.5 }}
                >
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
                </motion.div>

                {/* Divider */}
                <motion.div
                    animate={{ opacity: 1 }}
                    className="flex w-48 items-center gap-3"
                    initial={{ opacity: 0 }}
                    transition={{ delay: 0.8, duration: 0.4 }}
                >
                    <div className="h-px flex-1" style={{ backgroundColor: "rgba(202,255,0,0.08)" }} />
                    <span className="text-xs" style={{ color: "#3c3c3c", fontFamily: '"Geist Variable", sans-serif' }}>
                        <Trans>or</Trans>
                    </span>
                    <div className="h-px flex-1" style={{ backgroundColor: "rgba(202,255,0,0.08)" }} />
                </motion.div>

                {/* Primary CTA */}
                <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 10 }} transition={{ delay: 0.9, duration: 0.5 }}>
                    {/* A link styled as a button: it navigates, so it keeps link semantics. */}
                    <Link className={buttonVariants()} to="/">
                        <Trans>Return home</Trans>
                    </Link>
                </motion.div>
            </div>
        </div>
    );
};

export default NotFound;
