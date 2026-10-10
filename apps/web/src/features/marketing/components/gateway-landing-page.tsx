"use client";

import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@neore/ui/components/accordion";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { Activity, ArrowRight, BarChart3, Check, DollarSign, Gauge, Globe, Key, Layers, Lock, Route, Shield } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { LinkButton } from "@/components/link-button";

import GatewayFooter from "./gateway-footer";
import type { NavTheme } from "./gateway-navbar";
import GatewayNavbar from "./gateway-navbar";
import SectionSeperator from "./section-seperator";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const providers = [
    { description: msg`GPT-4o, GPT-4o Mini, o1, o3, DALL-E, Whisper`, icon: OpenAIMono, name: "OpenAI" },
    { description: msg`Gemini 2.5 Pro, Flash, Imagen, Veo, text-embedding`, icon: GoogleMono, name: "Google" },
    { description: msg`Claude Opus, Sonnet, Haiku — latest model family`, icon: AnthropicMono, name: "Anthropic" },
    { description: msg`Grok 3, Grok 3 Mini — real-time knowledge`, icon: XAIMono, name: "xAI" },
    { description: msg`LLaMA, Mixtral, Gemma — fastest inference`, icon: GroqMono, name: "Groq" },
    { description: msg`Mistral Large, Medium, Small, Codestral`, icon: MistralMono, name: "Mistral" },
];

const features = [
    {
        description: msg`One API endpoint, any model. Switch providers with a single parameter — no SDK changes, no migration headaches. OpenAI-compatible format.`,
        icon: Layers,
        tabLabel: msg`Unified API`,
        title: msg`One endpoint. Every model.`,
    },
    {
        description: msg`Automatic query classification (Simple/Standard/Complex/Reasoning) routes each request to the optimal model. Health-aware fallback with circuit breaker pattern ensures 99.9% uptime.`,
        icon: Route,
        tabLabel: msg`Smart Routing`,
        title: msg`The right model, every time.`,
    },
    {
        description: msg`Real-time token counting, per-request cost calculation, and daily usage aggregation. D1-backed analytics with Prometheus metrics endpoint. Know exactly what you spend.`,
        icon: BarChart3,
        tabLabel: msg`Usage Analytics`,
        title: msg`Track every token and dollar.`,
    },
];

const technicalFeatures = [
    {
        description: msg`Request validation, content filtering, and HMAC-SHA256 authentication on every request.`,
        icon: Shield,
        title: msg`Content safety`,
    },
    {
        description: msg`Automatic provider health tracking with circuit breaker pattern. Failed providers are bypassed within 30 seconds.`,
        icon: Activity,
        title: msg`Circuit breakers`,
    },
    {
        description: msg`Model pricing from models.dev, KV-cached for 24 hours. Automatic cost calculation in microdollars.`,
        icon: DollarSign,
        title: msg`Auto pricing`,
    },
    {
        description: msg`KV-backed rate limiting per user and tier. Configurable burst and sustained limits.`,
        icon: Gauge,
        title: msg`Rate limiting`,
    },
    {
        description: msg`Bring your own API keys for any supported provider. Keys are encrypted at rest and never logged.`,
        icon: Key,
        title: msg`BYOK support`,
    },
    {
        description: msg`Runs on Cloudflare Workers — sub-50ms cold starts, 300+ edge locations worldwide.`,
        icon: Globe,
        title: msg`Edge deployed`,
    },
];

const apiEndpoints = [
    { description: msg`Text generation with streaming support`, method: "POST", path: "/v1/completions" },
    { description: msg`Vector embeddings for any text`, method: "POST", path: "/v1/embeddings" },
    { description: msg`Image generation (DALL-E, Imagen, FLUX)`, method: "POST", path: "/v1/images" },
    { description: msg`Speech synthesis and transcription`, method: "POST", path: "/v1/audio" },
    { description: msg`Video generation (Runway, Luma, Kling)`, method: "POST", path: "/v1/videos" },
    { description: msg`List all available models and pricing`, method: "GET", path: "/v1/models" },
    { description: msg`Query usage analytics and costs`, method: "GET", path: "/v1/usage" },
    { description: msg`Prompt cache management`, method: "POST", path: "/v1/cache" },
];

const pricingTiers = [
    {
        annualPrice: 0,
        cta: msg`Start building`,
        description: msg`For side projects and experimentation.`,
        features: [msg`1,000 requests/day`, msg`All providers`, msg`Smart routing`, msg`Usage dashboard`, msg`Community support`],
        href: "/auth/sign-up" as const,
        monthlyPrice: 0,
        id: "free",
        name: msg`Free`,
        popular: false,
    },
    {
        annualPrice: 29,
        cta: msg`Start free trial`,
        description: msg`For production applications.`,
        features: [
            msg`50,000 requests/day`,
            msg`All providers + BYOK`,
            msg`Smart routing + fallback`,
            msg`Real-time analytics`,
            msg`Webhook notifications`,
            msg`Priority support`,
        ],
        href: "/auth/sign-up" as const,
        monthlyPrice: 39,
        id: "pro",
        name: msg`Pro`,
        popular: true,
    },
    {
        annualPrice: 99,
        cta: msg`Start free trial`,
        description: msg`For teams shipping AI products.`,
        features: [
            msg`Unlimited requests`,
            msg`Everything in Pro`,
            msg`Custom rate limits`,
            msg`SSO & team management`,
            msg`SLA guarantee`,
            msg`Dedicated support`,
        ],
        href: "/auth/sign-up" as const,
        monthlyPrice: 129,
        id: "team",
        name: msg`Team`,
        popular: false,
    },
    {
        annualPrice: null,
        cta: msg`Contact sales`,
        description: msg`Custom deployment for your org.`,
        features: [
            msg`Everything in Team`,
            msg`On-premise option`,
            msg`Custom integrations`,
            msg`Dedicated infrastructure`,
            msg`99.99% SLA`,
            msg`24/7 support`,
        ],
        href: "/auth/sign-up" as const,
        monthlyPrice: null,
        id: "enterprise",
        name: msg`Enterprise`,
        popular: false,
    },
];

const faqItems = [
    {
        answer: msg`Neore Gateway is a unified LLM API proxy that sits between your application and AI providers like OpenAI, Google, Anthropic, xAI, Groq, and Mistral. It provides smart model routing, automatic fallback, usage tracking, and cost optimization — all through a single, OpenAI-compatible API endpoint.`,
        question: msg`What is Neore Gateway?`,
    },
    {
        answer: msg`Yes. Neore Gateway uses an OpenAI-compatible API format. If your application already uses the OpenAI SDK, you only need to change the base URL and API key. No code changes to your prompts, tools, or streaming logic.`,
        question: msg`Is it compatible with the OpenAI SDK?`,
    },
    {
        answer: msg`Neore Gateway supports OpenAI (GPT-4o, o1, o3, DALL-E), Google (Gemini 2.5, Imagen, Veo), Anthropic (Claude 4), xAI (Grok 3), Groq (LLaMA, Mixtral), Mistral (Large, Codestral), and more via OpenRouter. New providers are added regularly.`,
        question: msg`Which providers are supported?`,
    },
    {
        answer: msg`Smart routing automatically classifies each query by complexity (Simple, Standard, Complex, Reasoning) and routes it to the optimal model based on capability, cost, and provider health. If a provider is down, the circuit breaker triggers automatic fallback within 30 seconds.`,
        question: msg`How does smart routing work?`,
    },
    {
        answer: msg`Yes. You can bring your own API keys for any supported provider. Keys are encrypted at rest, never logged, and passed directly to the provider. This lets you use your own billing relationship while still benefiting from routing, analytics, and fallback.`,
        question: msg`Can I use my own API keys?`,
    },
    {
        answer: msg`Neore Gateway runs on Cloudflare Workers at 300+ edge locations. Cold start is under 50ms. The proxy overhead is typically 5-15ms. Provider response times are the main latency factor, and smart routing selects the fastest healthy provider for each request.`,
        question: msg`What's the latency overhead?`,
    },
];

const TOTAL_SECTIONS = 8;

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const fadeUp = {
    hidden: { opacity: 0, y: 30 },
    visible: { opacity: 1, y: 0 },
};

const fadeSlideLeft = {
    hidden: { opacity: 0, x: -40 },
    visible: { opacity: 1, x: 0 },
};

const fadeSlideRight = {
    hidden: { opacity: 0, x: 40 },
    visible: { opacity: 1, x: 0 },
};

const scaleUp = {
    hidden: { opacity: 0, scale: 0.95 },
    visible: { opacity: 1, scale: 1 },
};

const staggerContainer = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.08 } },
};

const staggerContainerSlow = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.12 } },
};

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

const FadeIn = ({
    children,
    className,
    delay = 0,
    variant = "up",
}: {
    children: React.ReactNode;
    className?: string;
    delay?: number;
    variant?: "left" | "right" | "scale" | "up";
}) => {
    const variants = { left: fadeSlideLeft, right: fadeSlideRight, scale: scaleUp, up: fadeUp };

    return (
        <motion.div
            className={className}
            initial="hidden"
            transition={{ delay, duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
            variants={variants[variant]}
            viewport={{ margin: "-60px", once: true }}
            whileInView="visible"
        >
            {children}
        </motion.div>
    );
};

const SectionBadge = ({ className, index, light = false, title }: { className?: string; index: number; light?: boolean; title: string }) => (
    <motion.div
        className={clsx(
            "border-y",
            {
                "border-brand-silver bg-brand-white": light,
            },
            className,
        )}
        initial="hidden"
        viewport={{ margin: "-20px", once: true }}
        whileInView="visible"
    >
        <div
            className={clsx("relative container mx-auto flex w-full items-center gap-4 border-x px-4 py-3 sm:gap-10 sm:px-0 lg:py-10", {
                "border-brand-silver": light,
            })}
        >
            <motion.div
                className="bg-primary w-1"
                transition={{ duration: 0.4, ease: "easeOut" }}
                variants={{ hidden: { height: 0 }, visible: { height: 16 } }}
            />
            <motion.div
                className={clsx("inline-block font-mono text-xs tracking-widest", {
                    "text-background/40": light,
                    "text-foreground/40": !light,
                })}
                transition={{ delay: 0.15, duration: 0.4, ease: "easeOut" }}
                variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
            >
                [ <span className="text-primary">{String(index).padStart(2, "0")}</span> / <span>{String(TOTAL_SECTIONS).padStart(2, "0")}</span> ]
            </motion.div>
            <motion.span
                className={clsx("text-sm font-medium tracking-wide", {
                    "text-background/60": light,
                    "text-foreground/60": !light,
                })}
                transition={{ delay: 0.25, duration: 0.4, ease: "easeOut" }}
                variants={{ hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0 } }}
            >
                {title}
            </motion.span>
        </div>
    </motion.div>
);

// ---------------------------------------------------------------------------
// Code example
// ---------------------------------------------------------------------------

const codeExample = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://gateway.neore.ai/v1",
  apiKey: process.env.NEORE_API_KEY,
});

const response = await client.chat.completions.create({
  model: "auto", // smart routing picks the best model
  messages: [
    { role: "user", content: "Explain quantum computing" }
  ],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const GatewayLandingPage: FC = () => {
    const { i18n, t } = useLingui();
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const [scrollContainerMounted, setScrollContainerMounted] = useState(false);
    const [isAnnual, setIsAnnual] = useState(true);

    const setScrollContainerRefCallback = useCallback((node: HTMLDivElement | null) => {
        scrollContainerRef.current = node;

        if (node) {
            setScrollContainerMounted(true);
        }
    }, []);

    const [navTheme, setNavTheme] = useState<NavTheme>("dark");

    useEffect(() => {
        const container = scrollContainerRef.current;

        if (!container) {
            return undefined;
        }

        let rafId: number;
        const NAV_HEIGHT = 56;

        const handleScroll = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const zones = container.querySelectorAll<HTMLElement>("[data-nav-theme]");
                let currentTheme: NavTheme = "dark";

                for (const zone of zones) {
                    const rect = zone.getBoundingClientRect();

                    if (rect.top <= NAV_HEIGHT && rect.bottom > NAV_HEIGHT) {
                        currentTheme = zone.dataset.navTheme as NavTheme;
                    }
                }

                setNavTheme(currentTheme);
            });
        };

        container.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll();

        return () => {
            container.removeEventListener("scroll", handleScroll);
            cancelAnimationFrame(rafId);
        };
    }, [scrollContainerMounted]);

    return (
        <div className="relative h-screen overflow-y-auto scroll-smooth font-mono" ref={setScrollContainerRefCallback}>
            <GatewayNavbar theme={navTheme} />

            {/* ================================================================ */}
            {/* DARK ZONE: Hero + Providers */}
            {/* ================================================================ */}
            <div data-nav-theme="dark" id="hero">
                {/* Hero */}
                <section className="relative container mx-auto mt-px flex min-h-[85svh] flex-col items-center justify-center border-x px-4 pt-24 pb-12 sm:min-h-screen sm:pt-32 sm:pb-20">
                    <SectionSeperator />
                    <div className="mx-auto w-full max-w-3xl text-center">
                        <span className="text-primary mb-3 inline-block font-mono text-[10px] font-medium tracking-widest uppercase sm:mb-4 sm:text-xs">
                            {t`Completions · Embeddings · Images · Audio · Video`}
                        </span>
                        <h1 className="mb-4 text-3xl leading-[1.1] font-bold tracking-tight sm:mb-6 sm:text-5xl md:text-6xl lg:text-[4.5rem]">
                            <Trans>
                                One API.
                                <br />
                                <span className="text-primary">Every LLM.</span>
                            </Trans>
                        </h1>
                        <p className="mx-auto mb-8 max-w-3xl text-base leading-relaxed text-white/60 sm:mb-10 sm:text-lg">
                            {t`Unified access to OpenAI, Google, Anthropic, xAI, Groq, and Mistral through a single endpoint. Smart routing, automatic fallback, real-time usage tracking, and cost optimization — built on Cloudflare Workers.`}
                        </p>
                    </div>

                    {/* Code preview */}
                    <div className="mx-auto w-full max-w-2xl">
                        <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] backdrop-blur-sm">
                            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                                <div className="flex gap-1.5">
                                    <div className="size-2.5 rounded-full bg-white/10" />
                                    <div className="size-2.5 rounded-full bg-white/10" />
                                    <div className="size-2.5 rounded-full bg-white/10" />
                                </div>
                                <span className="ml-2 font-mono text-[10px] tracking-wider text-white/30">index.ts</span>
                            </div>
                            <pre className="overflow-x-auto px-4 py-4 font-mono text-xs leading-relaxed text-white/70 sm:text-sm">
                                <code>{codeExample}</code>
                            </pre>
                        </div>
                        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
                            <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                {t`Get API key`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`Read the docs`}
                            </Button>
                        </div>
                        <p className="mt-3 flex items-center justify-center gap-1 text-center text-xs text-white/30">
                            <Lock className="size-3" />
                            {t`Free tier included. No credit card required.`}
                        </p>
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 01 — Providers */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={1} title={t`Providers`} />
                <section className="relative container mx-auto border-x" id="providers">
                    <SectionSeperator />

                    <div className="px-4 py-16 sm:px-6 sm:py-28 lg:px-10">
                        <FadeIn>
                            <div className="mb-10 sm:mb-16">
                                <h2 className="mb-3 max-w-xl text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Every provider. <span className="text-primary">One SDK.</span>
                                    </Trans>
                                </h2>
                                <p className="max-w-xl text-base text-white/50 sm:text-lg">
                                    {t`Switch between OpenAI, Google, Anthropic, and more with a single parameter. No SDK changes, no migration.`}
                                </p>
                            </div>
                        </FadeIn>
                    </div>

                    <motion.div
                        className="grid grid-cols-1 border-t border-white/10 sm:grid-cols-2 lg:grid-cols-3"
                        initial="hidden"
                        variants={staggerContainer}
                        viewport={{ margin: "-80px", once: true }}
                        whileInView="visible"
                    >
                        {providers.map((provider, index) => (
                            <motion.div
                                className={cn(
                                    "border-b border-white/10 px-4 py-8 sm:px-6 sm:py-10 lg:px-10",
                                    index % 2 !== 0 && "sm:border-l sm:border-white/10 lg:border-l-0",
                                    index % 3 !== 0 && "lg:border-l lg:border-white/10",
                                )}
                                key={provider.name}
                                transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                variants={fadeUp}
                            >
                                <div className="mb-4 flex items-center gap-3">
                                    <provider.icon className="text-white" size={24} />
                                    <span className="text-sm font-medium text-white/80">{provider.name}</span>
                                </div>
                                <p className="text-xs leading-relaxed text-white/40">{i18n._(provider.description)}</p>
                            </motion.div>
                        ))}
                    </motion.div>
                </section>
            </div>
            {/* END DARK ZONE */}

            {/* ================================================================ */}
            {/* LIGHT ZONE: Features + Technical */}
            {/* ================================================================ */}
            <div data-nav-theme="light">
                {/* ---------------------------------------------------------------- */}
                {/* 02 — Features */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={2} light title={t`Features`} />

                <section className="bg-brand-white" id="features">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Route, track, <span className="text-primary">optimize.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">
                                    {t`More than a proxy — an intelligent layer between your app and every LLM provider.`}
                                </p>
                            </div>
                        </FadeIn>

                        {features.map((feature, index) => (
                            <div className="border-brand-silver border-t" key={feature.title.id}>
                                <div className="grid grid-cols-1 lg:grid-cols-2">
                                    <FadeIn variant={index % 2 === 0 ? "left" : "right"}>
                                        <div className="relative overflow-hidden px-4 py-8 sm:px-6 sm:py-12 lg:px-10 lg:py-20">
                                            <motion.span
                                                className="text-brand-obsidian/[0.04] pointer-events-none absolute top-1 left-2 font-mono text-[5rem] leading-none font-bold sm:top-2 sm:left-4 sm:text-[8rem] lg:text-[10rem]"
                                                initial={{ opacity: 0, scale: 0.8 }}
                                                transition={{ delay: 0.2, duration: 0.8, ease: "easeOut" }}
                                                viewport={{ once: true }}
                                                whileInView={{ opacity: 1, scale: 1 }}
                                            >
                                                {String(index + 1).padStart(2, "0")}
                                            </motion.span>
                                            <div className="relative">
                                                <div className="mb-5 flex items-center gap-3">
                                                    <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
                                                        <feature.icon className="size-4" />
                                                    </div>
                                                    <span className="text-primary font-mono text-xs font-medium tracking-widest uppercase">
                                                        {i18n._(feature.tabLabel)}
                                                    </span>
                                                </div>
                                                <h3 className="text-brand-obsidian max-w-sm text-2xl font-bold lg:text-3xl">{i18n._(feature.title)}</h3>
                                            </div>
                                        </div>
                                    </FadeIn>
                                    <FadeIn delay={0.15} variant={index % 2 === 0 ? "right" : "left"}>
                                        <div className="border-brand-silver flex flex-col justify-center px-4 pb-8 sm:px-6 sm:pb-12 lg:border-l lg:px-10 lg:py-20">
                                            <p className="text-brand-graphite mb-6 text-base leading-relaxed sm:mb-8 sm:text-lg">
                                                {i18n._(feature.description)}
                                            </p>
                                            <div>
                                                <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                                    {t`Get started`} <ArrowRight className="ml-2 size-4" />
                                                </LinkButton>
                                            </div>
                                        </div>
                                    </FadeIn>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 03 — Technical Features */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={3} light title={t`Under the Hood`} />

                <section className="bg-brand-white">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Built for <span className="text-primary">production.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">
                                    {t`Enterprise-grade infrastructure that scales with your application.`}
                                </p>
                            </div>
                        </FadeIn>

                        <motion.div
                            className="border-brand-silver grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-3"
                            initial="hidden"
                            variants={staggerContainer}
                            viewport={{ margin: "-60px", once: true }}
                            whileInView="visible"
                        >
                            {technicalFeatures.map((feature, index) => (
                                <motion.div
                                    className={cn(
                                        "border-brand-silver border-b px-4 py-8 sm:px-6 sm:py-10 lg:px-10",
                                        index % 2 !== 0 && "sm:border-brand-silver sm:border-l lg:border-l-0",
                                        index % 3 !== 0 && "lg:border-brand-silver lg:border-l",
                                    )}
                                    key={feature.title.id}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                >
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
                                            <feature.icon className="size-4" />
                                        </div>
                                        <span className="text-primary font-mono text-xs font-medium tracking-widest uppercase">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                    </div>
                                    <h3 className="text-brand-obsidian mb-2 text-lg font-bold">{i18n._(feature.title)}</h3>
                                    <p className="text-brand-graphite text-sm leading-relaxed">{i18n._(feature.description)}</p>
                                </motion.div>
                            ))}
                        </motion.div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* ================================================================ */}
            {/* DARK ZONE: Mid-page CTA */}
            {/* ================================================================ */}
            <div data-nav-theme="dark">
                <section className="bg-primary border-brand-silver -mt-px border-t">
                    <div className="border-primary/20 container mx-auto px-4 py-14 text-center sm:px-6 sm:py-20 lg:px-10">
                        <FadeIn variant="scale">
                            <h2 className="text-primary-foreground mb-3 text-2xl font-bold sm:text-3xl md:text-4xl">{t`Stop managing six provider SDKs.`}</h2>
                            <p className="text-primary-foreground/70 mx-auto mb-6 max-w-md text-sm sm:mb-8 sm:text-base">
                                {t`One API key, one SDK, one dashboard. Smart routing handles the rest.`}
                            </p>
                            <motion.div className="inline-block" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                    {t`Get your API key`} <ArrowRight className="ml-2 size-4" />
                                </LinkButton>
                            </motion.div>
                        </FadeIn>
                    </div>
                </section>
            </div>
            {/* END DARK ZONE */}

            {/* ================================================================ */}
            {/* LIGHT ZONE: API Endpoints + Pricing + FAQ */}
            {/* ================================================================ */}
            <div data-nav-theme="light">
                {/* ---------------------------------------------------------------- */}
                {/* 04 — API Endpoints */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={5} light title={t`API Reference`} />

                <section className="bg-brand-white">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        OpenAI-compatible <span className="text-primary">API.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">
                                    {t`Drop-in replacement for the OpenAI SDK. Change one line and access every provider.`}
                                </p>
                            </div>
                        </FadeIn>

                        <motion.div
                            className="border-brand-silver border-t"
                            initial="hidden"
                            variants={staggerContainer}
                            viewport={{ margin: "-60px", once: true }}
                            whileInView="visible"
                        >
                            {apiEndpoints.map((endpoint) => (
                                <motion.div
                                    className={cn("border-brand-silver flex items-center gap-4 border-b px-4 py-4 sm:px-6 sm:py-5 lg:px-10")}
                                    key={`${endpoint.method} ${endpoint.path}`}
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                >
                                    <span
                                        className={cn(
                                            "inline-block w-14 shrink-0 rounded font-mono text-[10px] font-bold tracking-wider",
                                            endpoint.method === "POST" ? "text-primary" : "text-blue-500",
                                        )}
                                    >
                                        {endpoint.method}
                                    </span>
                                    <code className="text-brand-obsidian text-sm font-medium">{endpoint.path}</code>
                                    <span className="text-brand-graphite hidden text-xs sm:inline">{i18n._(endpoint.description)}</span>
                                </motion.div>
                            ))}
                        </motion.div>

                        <div className="border-brand-silver flex flex-col items-center justify-center gap-3 px-4 py-8 sm:flex-row sm:px-6 sm:py-10 lg:px-10">
                            <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                {t`Get API key`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`View full docs`}
                            </Button>
                        </div>
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 06 — Pricing */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={6} light title={t`Pricing`} />

                <section className="bg-brand-white" id="pricing">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Pay for what <span className="text-primary">you use.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite mx-auto mb-6 max-w-lg text-base sm:mb-8 sm:text-lg">
                                    {t`Free tier to start. Scale as you grow. Provider costs passed through at cost — you only pay for the gateway.`}
                                </p>

                                {/* Billing toggle */}
                                <div className="flex items-center justify-center gap-3">
                                    <span className={cn("text-sm transition-colors", isAnnual ? "text-brand-graphite" : "text-brand-obsidian font-semibold")}>
                                        {t`Monthly`}
                                    </span>
                                    <button
                                        aria-checked={isAnnual}
                                        aria-label={t`Annual billing`}
                                        className={cn(
                                            "relative inline-flex h-7 w-12 items-center rounded-full transition-colors",
                                            isAnnual ? "bg-primary" : "bg-brand-silver",
                                        )}
                                        onClick={() => setIsAnnual(!isAnnual)}
                                        role="switch"
                                        type="button"
                                    >
                                        <motion.span
                                            animate={{ x: isAnnual ? 26 : 4 }}
                                            className="bg-brand-white inline-block size-5 rounded-full shadow-sm"
                                            transition={{ damping: 30, stiffness: 500, type: "spring" }}
                                        />
                                    </button>
                                    <span className={cn("text-sm transition-colors", isAnnual ? "text-brand-obsidian font-semibold" : "text-brand-graphite")}>
                                        {t`Annual`}
                                        <span className="text-primary ml-1.5 text-xs font-semibold">{t`Save 25%`}</span>
                                    </span>
                                </div>
                            </div>
                        </FadeIn>

                        <motion.div
                            className="border-brand-silver grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-4"
                            initial="hidden"
                            variants={staggerContainerSlow}
                            viewport={{ margin: "-60px", once: true }}
                            whileInView="visible"
                        >
                            {pricingTiers.map((tier, index) => (
                                <motion.div
                                    className={cn(
                                        "border-brand-silver relative flex h-full flex-col border-b px-4 py-8 sm:px-6 sm:py-10 lg:px-8",
                                        index % 2 !== 0 && "border-brand-silver max-lg:border-l max-sm:border-l-0",
                                        index > 0 && "lg:border-brand-silver lg:border-l",
                                        tier.popular && "bg-brand-frost",
                                    )}
                                    key={tier.id}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                    whileHover={{ y: -4 }}
                                >
                                    {tier.popular && (
                                        <span className="bg-primary text-primary-foreground mb-4 inline-block self-start rounded-full px-3 py-0.5 text-[11px] font-semibold">
                                            {t`Popular`}
                                        </span>
                                    )}
                                    <h3 className="text-brand-obsidian mb-1 text-lg font-bold">{i18n._(tier.name)}</h3>
                                    <p className="text-brand-graphite mb-5 text-sm">{i18n._(tier.description)}</p>

                                    <div className="mb-6">
                                        {tier.monthlyPrice === null ? (
                                            <span className="text-brand-obsidian font-mono text-4xl font-bold">{t`Custom`}</span>
                                        ) : (
                                            <div className="flex items-baseline gap-1">
                                                <motion.span
                                                    animate={{ opacity: 1, y: 0 }}
                                                    className="text-brand-obsidian font-mono text-4xl font-bold"
                                                    initial={{ opacity: 0, y: -8 }}
                                                    key={isAnnual ? "annual" : "monthly"}
                                                    transition={{ damping: 25, stiffness: 300, type: "spring" }}
                                                >
                                                    ${isAnnual ? tier.annualPrice : tier.monthlyPrice}
                                                </motion.span>
                                                <span className="text-brand-graphite text-sm">/{t`mo`}</span>
                                            </div>
                                        )}
                                    </div>

                                    <ul className="mb-8 flex-1 space-y-3">
                                        {tier.features.map((feature) => (
                                            <li className="text-brand-graphite flex items-start gap-2 text-sm" key={feature.id}>
                                                <Check className="text-primary mt-0.5 size-4 shrink-0" />
                                                {i18n._(feature)}
                                            </li>
                                        ))}
                                    </ul>

                                    <LinkButton className="w-full" size="marketing" to={tier.href} variant={tier.popular ? "marketing" : "marketing-ghost"}>
                                        {i18n._(tier.cta)}
                                    </LinkButton>
                                </motion.div>
                            ))}
                        </motion.div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* ================================================================ */}
            {/* DARK ZONE: CTA */}
            {/* ================================================================ */}
            <div data-nav-theme="dark">
                <SectionBadge index={7} title={t`Get Started`} />

                <section>
                    <div className="relative container mx-auto border-x px-4 py-16 text-center sm:px-6 sm:py-28 lg:px-10">
                        <SectionSeperator />
                        <FadeIn variant="scale">
                            <h2 className="mb-3 text-3xl font-bold sm:mb-4 sm:text-4xl md:text-5xl">
                                <Trans>
                                    Ship AI features <span className="text-primary">faster.</span>
                                </Trans>
                            </h2>
                            <p className="mx-auto mb-6 max-w-md text-base text-white/50 sm:mb-8 sm:text-lg">
                                {t`One API key, every model, production-ready infrastructure. Free tier included — start building in minutes.`}
                            </p>
                            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
                                <motion.div className="w-full sm:w-auto" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                    <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                        {t`Get API key`} <ArrowRight className="ml-2 size-4" />
                                    </LinkButton>
                                </motion.div>
                                <Button size="marketing" variant="marketing-ghost">
                                    {t`Talk to sales`}
                                </Button>
                            </div>
                        </FadeIn>
                    </div>
                </section>
            </div>
            {/* END DARK ZONE */}

            {/* ================================================================ */}
            {/* LIGHT ZONE: FAQ */}
            {/* ================================================================ */}
            <div data-nav-theme="light">
                <SectionBadge index={8} light title={t`FAQ`} />

                <section className="bg-brand-white" id="faq">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Frequently asked <span className="text-primary">questions</span>.
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite text-sm sm:text-base">{t`Everything you need to know about Neore Gateway.`}</p>
                            </div>
                        </FadeIn>

                        <div className="border-brand-silver border-t">
                            <Accordion>
                                {faqItems.map((item, index) => (
                                    <AccordionItem className="border-brand-silver" key={item.question.id}>
                                        <AccordionTrigger className="text-brand-obsidian px-4 py-4 text-left text-sm font-semibold hover:no-underline sm:px-6 sm:py-5 lg:px-10">
                                            <span className="text-primary mr-3 font-mono text-xs font-normal tracking-wider sm:mr-4">
                                                {String(index + 1).padStart(2, "0")}
                                            </span>
                                            {i18n._(item.question)}
                                        </AccordionTrigger>
                                        <AccordionContent className="text-brand-graphite px-4 text-sm sm:px-6 lg:px-10 lg:pl-[4.5rem]">
                                            {i18n._(item.answer)}
                                        </AccordionContent>
                                    </AccordionItem>
                                ))}
                            </Accordion>
                        </div>

                        <div className="border-brand-silver flex flex-col items-center justify-center gap-3 border-t px-4 py-8 sm:flex-row sm:px-6 sm:py-10 lg:px-10">
                            <LinkButton size="marketing" to="/auth/sign-up" variant="marketing">
                                {t`Get API key`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`Contact support`}
                            </Button>
                        </div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* Footer */}
            <div data-nav-theme="dark">
                <GatewayFooter />
            </div>
        </div>
    );
};

export default GatewayLandingPage;
