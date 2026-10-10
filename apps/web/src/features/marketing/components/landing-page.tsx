"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import AlibabaText from "@lobehub/icons/es/Alibaba/components/Text";
import BflText from "@lobehub/icons/es/Bfl/components/Text";
import ByteDanceText from "@lobehub/icons/es/ByteDance/components/Text";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import HailuoText from "@lobehub/icons/es/Hailuo/components/Text";
import KlingText from "@lobehub/icons/es/Kling/components/Text";
import LumaText from "@lobehub/icons/es/Luma/components/Text";
import OpenAIText from "@lobehub/icons/es/OpenAI/components/Text";
import PikaText from "@lobehub/icons/es/Pika/components/Text";
import RecraftText from "@lobehub/icons/es/Recraft/components/Text";
import RunwayText from "@lobehub/icons/es/Runway/components/Text";
import StabilityText from "@lobehub/icons/es/Stability/components/Text";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@neore/ui/components/accordion";
import { Button } from "@neore/ui/components/button";
import LazyImage from "@neore/ui/components/lazy-image";
import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { ArrowRight, Bot, Brain, Check, FileText, Globe, Lightbulb, MessageSquareText, Search, Shield, Sparkles, Users, Zap } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentType, FC, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LinkButton } from "@/components/link-button";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import useCheckout from "@/features/billing/hooks/use-checkout";
import Composer from "@/features/chat/thread/composer";

import hero from "../assets/background.jpg?url";
import useScrollSticky from "../hooks/use-scroll-sticky";
import LandingChatProvider from "./landing-chat-provider";
import LandingFooter from "./landing-footer";
import LandingStickyBar from "./landing-sticky-bar";
import type { NavTheme } from "./navbar-menu";
import Navbar from "./navbar-menu";
import SectionSeperator from "./section-seperator";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface ModelProvider {
    gridClass: string;
    icon?: ComponentType<any>;
    media?: { poster?: string; src: string; type: "image" | "video" };
    models: { desc: MessageDescriptor; name: string }[];
    name: string;
}

const modelProviders: ModelProvider[] = [
    {
        gridClass: "lg:col-start-1 lg:col-end-4 lg:row-start-1 lg:row-end-2",
        icon: GoogleMono,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Image(3).png", type: "image" },
        models: [
            { desc: msg`Fast image generation`, name: "Gemini 2.5 Flash Image" },
            { desc: msg`High-quality image synthesis`, name: "Imagen 3" },
            { desc: msg`Next-gen image generation`, name: "Imagen 4" },
            { desc: msg`Advanced multimodal reasoning`, name: "Gemini 2.5 Pro" },
            { desc: msg`AI video generation`, name: "Veo2" },
            { desc: msg`Advanced video generation`, name: "Veo3" },
        ],
        name: "Google",
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-1 lg:row-end-3",
        icon: RunwayText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/runway-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/runway.webm/ik-video.mp4",
            type: "video",
        },
        models: [
            { desc: msg`Next-gen creative AI`, name: "Aleph" },
            { desc: msg`Fast video generation`, name: "Gen-4 Turbo" },
            { desc: msg`Style-consistent generation`, name: "References" },
            { desc: msg`Character performance`, name: "Act-Two" },
            { desc: msg`Video generation`, name: "Gen-3 Alpha" },
        ],
        name: "Runway",
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-2 lg:row-end-3",
        icon: AlibabaText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/wan-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/wan.webm/ik-video.mp4",
            type: "video",
        },
        models: [{ desc: msg`Open-source video AI`, name: "Wan2.2" }],
        name: "Wan",
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-4 lg:row-start-2 lg:row-end-3",
        icon: OpenAIText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Stack.png", type: "image" },
        models: [
            { desc: msg`Most capable language model`, name: "GPT-5" },
            { desc: msg`Fast and affordable AI`, name: "GPT-4o Mini" },
            { desc: msg`AI image generation`, name: "GPT Image" },
        ],
        name: "OpenAI",
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-3 lg:row-end-5",
        icon: BflText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Black%20Forest%20Labs.png", type: "image" },
        models: [
            { desc: msg`Professional image generation`, name: "FLUX 1.1 Pro" },
            { desc: msg`Context-aware generation`, name: "FLUX Kontext Max" },
            { desc: msg`Developer-friendly image AI`, name: "FLUX Dev" },
            { desc: msg`Image variation & editing`, name: "FLUX Redux" },
            { desc: msg`Depth-aware generation`, name: "FLUX Depth" },
            { desc: msg`Edge-guided generation`, name: "FLUX Canny" },
        ],
        name: "Black Forest Labs",
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-3 lg:row-end-4",
        icon: LumaText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/luma-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/luma-ai.mp4",
            type: "video",
        },
        models: [
            { desc: msg`AI video editing`, name: "Modify Video" },
            { desc: msg`Cinematic video AI`, name: "Ray 2" },
            { desc: msg`Fast video generation`, name: "Ray 2 Flash" },
            { desc: msg`Image generation`, name: "Photon" },
        ],
        name: "Luma",
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-4 lg:row-end-5",
        icon: StabilityText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Stability.png", type: "image" },
        models: [{ desc: msg`Open image generation`, name: "Stable Diffusion 3.5" }],
        name: "Stability",
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-4 lg:row-end-5",
        icon: HailuoText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/hailuo.avif", type: "image" },
        models: [
            { desc: msg`AI video generation`, name: "Minimax Hailuo" },
            { desc: msg`Advanced video AI`, name: "Minimax Hailuo 02 Pro" },
        ],
        name: "Hailuo",
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-5 lg:row-end-6",
        icon: PikaText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/pika-poster.png", type: "image" },
        models: [{ desc: msg`Creative video AI`, name: "Pika" }],
        name: "Pika",
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-4 lg:row-start-5 lg:row-end-6",
        icon: KlingText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/kling-poster.png", type: "image" },
        models: [
            { desc: msg`Cinematic AI video`, name: "Kling 2.1 Master" },
            { desc: msg`Video generation`, name: "Kling 2.0 Master" },
            { desc: msg`Professional video AI`, name: "Kling Pro 1.5" },
            { desc: msg`Enhanced video AI`, name: "Kling Pro 1.6" },
        ],
        name: "Kling",
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-5 lg:row-end-6",
        icon: RecraftText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Recraft.png", type: "image" },
        models: [{ desc: msg`Vector & design AI`, name: "Recraft V3" }],
        name: "Recraft",
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-6 lg:row-end-7",
        icon: ByteDanceText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/bytedance-poster.png", type: "image" },
        models: [
            { desc: msg`AI image generation`, name: "Seedream 4.0" },
            { desc: msg`AI video creation`, name: "Seedance 1.0 Pro" },
        ],
        name: "ByteDance Seed",
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-6 lg:row-end-7",
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/moonvaley-poster.png", type: "image" as const },
        models: [{ desc: msg`Cinematic video AI`, name: "Marey" }],
        name: "Moonvalley",
    },
];

const features = [
    {
        description: msg`Switch between GPT-4, Claude, Gemini, and DeepSeek mid-conversation. Compare answers, pick the best one — no extra tabs, no extra logins.`,
        icon: Bot,
        tabLabel: msg`Multi-Model Chat`,
        title: msg`Every leading AI model. One conversation.`,
    },
    {
        description: msg`Create images with FLUX, Imagen, and Stable Diffusion. Generate videos with Runway, Luma, and Kling. Compare outputs across providers — pick the best result, not the only result.`,
        icon: Sparkles,
        tabLabel: msg`Image & Video`,
        title: msg`From prompt to production-ready visuals.`,
    },
    {
        description: msg`Draft, edit, and refine long-form content in a side-by-side canvas. AI handles the first draft — you shape the final version.`,
        icon: FileText,
        tabLabel: msg`Canvas`,
        title: msg`A document editor that thinks with you.`,
    },
];

const benefits = [
    {
        description: msg`ChatGPT ($20), Midjourney ($10–30), Runway ($15), Claude ($20) — that's $85+/month. Neore gives you all of them for $20.`,
        icon: Zap,
        title: msg`One subscription, not six`,
    },
    {
        description: msg`Ask GPT-4, Claude, and Gemini the same question. Run the same prompt across FLUX, Imagen, and Stable Diffusion. Pick the winner — not the default.`,
        icon: Search,
        title: msg`Compare before you commit`,
    },
    {
        description: msg`Start a conversation, generate images, write a document in canvas, run code — no tab-switching, no copy-pasting between apps.`,
        icon: FileText,
        title: msg`Idea to finished output, one thread`,
    },
    {
        description: msg`Threads keep your full history. Branch ideas, pin important chats, and pick up exactly where you left off.`,
        icon: MessageSquareText,
        title: msg`Context that never resets`,
    },
    {
        description: msg`We never train on your data. GDPR compliant. Full export anytime. Your conversations and creations stay yours.`,
        icon: Shield,
        title: msg`Private by default`,
    },
    {
        description: msg`Connect APIs, databases, and custom services through integrations. Your workspace grows with your needs.`,
        icon: Globe,
        title: msg`Plug in your own tools`,
    },
];

const faqItems = [
    {
        answer: msg`Neore includes 30+ models: GPT-4, Claude, Gemini, and DeepSeek for chat. FLUX, Imagen, Stable Diffusion, and Recraft for images. Runway, Luma, Kling, and Pika for video. Switch between any of them mid-conversation.`,
        question: msg`Which AI models are included?`,
    },
    {
        answer: msg`Yes. Generate images with 10+ models including FLUX, Imagen 4, and Stable Diffusion. Create videos with Runway, Luma, Kling, Hailuo, and more. All from within a chat thread — compare results across providers instantly.`,
        question: msg`Can I generate images and videos?`,
    },
    {
        answer: msg`Canvas opens a side-by-side editor next to your chat. Write long-form documents, edit code, and refine content with AI assistance. Changes are versioned so you can always go back.`,
        question: msg`What is the Canvas feature?`,
    },
    {
        answer: msg`Yes. We never train on your conversations or generated content. All data is encrypted, GDPR-compliant, and exportable at any time. You own everything you create.`,
        question: msg`Is my data private?`,
    },
    {
        answer: msg`The free plan includes 20 text messages a day on a curated set of fast, low-cost models, image and video generation with small daily limits, canvas, code execution, and thread management. Premium models need Pro or your own API key. Pro and Team raise the limit to 1,000 messages a day on every model.`,
        question: msg`What's included in the free plan?`,
    },
    {
        answer: msg`ChatGPT gives you one model family. Neore gives you 30+ models from 12 providers — chat, image generation, video creation, a canvas editor, code execution, and deep research. Same $20/month, but you get GPT-4 plus Claude, Gemini, FLUX, Runway, and 25 more.`,
        question: msg`How is Neore different from ChatGPT?`,
    },
];

const platformTools = [
    { description: msg`Automated multi-step analysis with cited sources`, icon: Search, name: msg`Deep Research` },
    { description: msg`Run Python, see charts and images instantly`, icon: Zap, name: msg`Code Sandbox` },
    { description: msg`Write long-form content alongside chat`, icon: FileText, name: msg`Canvas Editor` },
    { description: msg`Summarize any webpage in seconds`, icon: Globe, name: msg`URL Retrieval` },
    { description: msg`10+ models — compare and pick the best`, icon: Sparkles, name: msg`Image Generation` },
    { description: msg`Runway, Luma, Kling, and more in one place`, icon: Bot, name: msg`Video Creation` },
    { description: msg`Connect any external tool or API`, icon: Brain, name: msg`Integrations` },
    { description: msg`Explore alternate ideas without losing context`, icon: MessageSquareText, name: msg`Message Branching` },
];

const USE_CASES = [
    {
        description: msg`Go from brief to published content — draft in chat, refine in canvas, generate images — without switching tools.`,
        icon: FileText,
        title: msg`Content Creation`,
    },
    {
        description: msg`Get cited, multi-step analysis in minutes. Deep Research reads sources so you don't have to.`,
        icon: Search,
        title: msg`Market Research`,
    },
    {
        description: msg`Compare concepts across FLUX, Runway, and Stable Diffusion. Pick the best style, not the only option.`,
        icon: Lightbulb,
        title: msg`Creative Direction`,
    },
    { description: msg`Write code with AI, run it in the sandbox, and document results — all in one thread.`, icon: Sparkles, title: msg`Technical Work` },
    {
        description: msg`Share threads, branch discussions, and give your whole team access to every model from one plan.`,
        icon: Users,
        title: msg`Team Alignment`,
    },
    { description: msg`Upload CSVs, run Python analysis, and export charts — no Jupyter setup required.`, icon: Brain, title: msg`Data & Analysis` },
];

// Monthly billing only: Creem sells the two monthly products (`billing/checkout.ts`).
const pricingTiers = [
    {
        cta: msg`Get started`,
        description: msg`Fast, low-cost models. 20 messages a day.`,
        features: [msg`Fast, low-cost models`, msg`Image & video generation, small daily limits`, msg`Canvas editor`, msg`Thread management`],
        href: "/chat" as const,
        monthlyPrice: 0,
        id: "free",
        name: msg`Free`,
        popular: false,
        priceUnit: msg`mo`,
    },
    {
        cta: msg`Sign up`,
        description: msg`Every model and tool, 1,000 messages a day.`,
        features: [
            msg`1,000 messages a day`,
            msg`All models & tools`,
            msg`Deep Research`,
            msg`Code execution`,
            msg`Custom instructions`,
            msg`Priority responses`,
        ],
        href: "/auth/sign-up" as const,
        monthlyPrice: 20,
        id: "pro",
        name: msg`Pro`,
        popular: true,
        priceUnit: msg`mo`,
    },
    {
        cta: msg`Sign up`,
        description: msg`Collaborate with shared AI workflows.`,
        features: [msg`Everything in Pro`, msg`Shared threads`, msg`Team management`, msg`Usage analytics`, msg`SSO`],
        href: "/auth/sign-up" as const,
        monthlyPrice: 30,
        id: "team",
        name: msg`Team`,
        popular: false,
        priceUnit: msg`seat/mo`,
    },
    {
        cta: msg`Contact sales`,
        description: msg`Custom deployment for your organization.`,
        features: [msg`Everything in Team`, msg`Dedicated support`, msg`Custom integrations`, msg`SLA guarantee`, msg`On-premise option`],
        href: "/chat" as const,
        monthlyPrice: null,
        id: "enterprise",
        name: msg`Enterprise`,
        popular: false,
        priceUnit: msg`mo`,
    },
];

const TOTAL_SECTIONS = 9;

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
    variant?: "up" | "left" | "right" | "scale";
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

/** Firecrawl-style numbered section marker: [ 01 / 10 ] with title. */
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

const LandingPage: FC = () => {
    const { i18n, t } = useLingui();
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const [scrollContainerMounted, setScrollContainerMounted] = useState(false);
    const { isAnonymous, user } = useIsAnonymous();
    const isSignedIn = !!user && !isAnonymous;
    const { isPending: checkoutPending, startCheckout } = useCheckout();

    const setScrollContainerRefCallback = useCallback((node: HTMLDivElement | null) => {
        scrollContainerRef.current = node;

        if (node) {
            setScrollContainerMounted(true);
        }
    }, []);

    const scrollStickyOptions = useMemo(() => (scrollContainerMounted ? { scrollContainerRef } : {}), [scrollContainerMounted]);

    const { isSticky, ref: composerRef } = useScrollSticky(scrollStickyOptions);

    const [navTheme, setNavTheme] = useState<NavTheme>("dark");

    useEffect(() => {
        const container = scrollContainerRef.current;

        if (!container) {
            return undefined;
        }

        let rafId: number;
        const NAV_HEIGHT = 56; // h-14 = 3.5rem = 56px

        const handleScroll = () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const zones = container.querySelectorAll<HTMLElement>("[data-nav-theme]");
                let currentTheme: NavTheme = "dark";

                for (const zone of zones) {
                    const rect = zone.getBoundingClientRect();

                    // Check if this zone's top is at or above the navbar bottom
                    if (rect.top <= NAV_HEIGHT && rect.bottom > NAV_HEIGHT) {
                        currentTheme = zone.dataset.navTheme as NavTheme;
                    }
                }

                setNavTheme(currentTheme);
            });
        };

        container.addEventListener("scroll", handleScroll, { passive: true });
        handleScroll(); // initial check

        return () => {
            container.removeEventListener("scroll", handleScroll);
            cancelAnimationFrame(rafId);
        };
    }, [scrollContainerMounted]);

    return (
        <div className="relative h-screen overflow-y-auto scroll-smooth font-mono" ref={setScrollContainerRefCallback}>
            {/* ---------------------------------------------------------------- */}
            {/* Navbar */}
            {/* ---------------------------------------------------------------- */}
            <Navbar theme={navTheme} />

            {/* ================================================================ */}
            {/* DARK ZONE: Hero → LogoCloud → Models */}
            {/* ================================================================ */}
            <div data-nav-theme="dark" id="hero">
                {/* Hero */}
                <section className="relative container mx-auto mt-px flex min-h-[85svh] flex-col items-center justify-center border-x px-4 pt-24 pb-12 sm:min-h-screen sm:pt-32 sm:pb-20">
                    <SectionSeperator />
                    <div className="mx-auto w-full max-w-3xl text-center">
                        <span className="text-primary mb-3 inline-block font-mono text-[10px] font-medium tracking-widest uppercase sm:mb-4 sm:text-xs">
                            {t`Chat · Images · Video · Audio · Documents`}
                        </span>
                        <h1 className="mb-4 text-3xl leading-[1.1] font-bold tracking-tight sm:mb-6 sm:text-5xl md:text-6xl lg:text-[4.5rem]">
                            <Trans>
                                Where thoughts
                                <br />
                                <span className="text-primary">become actions.</span>
                            </Trans>
                        </h1>
                        <p className="mx-auto mb-8 max-w-3xl text-base leading-relaxed text-white/60 sm:mb-10 sm:text-lg">
                            {t`One workspace for 30+ AI models. Chat, generate images, create videos, write documents, and run code — one account, one price.`}
                        </p>
                    </div>
                    <div className="mx-auto w-full max-w-6xl text-center">
                        <div className="relative" ref={composerRef}>
                            <LazyImage alt="" aspectRatioClassName="border-none" ratio={2.5} src={hero} />
                            <div className="absolute right-0 bottom-2 left-0 mx-auto w-full max-w-4xl px-2 sm:bottom-[10%] md:bottom-[15%] lg:px-0">
                                <LandingChatProvider>
                                    <Composer minimal />
                                </LandingChatProvider>
                                <p className="mt-1.5 hidden items-center justify-center gap-1 text-center text-xs font-semibold text-black sm:flex">
                                    <Shield className="size-3" />
                                    {t`Your conversations stay private`}
                                </p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 01 — Model Providers  (dark section) */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={1} title={t`Models`} />
                <section className="relative container mx-auto border-x" id="models">
                    <SectionSeperator />

                    <div className="px-4 py-16 sm:px-6 sm:py-28 lg:px-10">
                        <FadeIn>
                            <div className="mb-10 sm:mb-16">
                                <h2 className="mb-3 max-w-xl text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        One subscription. <span className="text-primary">Every model.</span>
                                    </Trans>
                                </h2>
                                <p className="max-w-xl text-base text-white/50 sm:text-lg">
                                    {t`GPT-4, Claude, Gemini, FLUX, Runway, Luma, and 25 more — one subscription replaces $100+/month in separate tools.`}
                                </p>
                            </div>
                        </FadeIn>

                        <div className="flex flex-wrap items-center gap-3">
                            <LinkButton size="marketing" to="/chat" variant="marketing">
                                {t`Try it free`}
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`Contact sales`} <ArrowRight className="ml-1.5 size-3.5" />
                            </Button>
                        </div>
                    </div>

                    <motion.div
                        className="container mx-auto grid grid-cols-1 border-x sm:grid-cols-2 lg:auto-rows-[200px] lg:grid-cols-4"
                        initial="hidden"
                        variants={staggerContainer}
                        viewport={{ margin: "-80px", once: true }}
                        whileInView="visible"
                    >
                        {modelProviders.map((provider) => {
                            let mediaBackground: ReactNode = null;

                            if (provider.media?.type === "video") {
                                mediaBackground = (
                                    <video
                                        autoPlay
                                        className="absolute inset-0 h-full w-full object-cover"
                                        loop
                                        muted
                                        playsInline
                                        poster={provider.media.poster}
                                    >
                                        <source src={provider.media.src} type="video/mp4" />
                                    </video>
                                );
                            } else if (provider.media) {
                                mediaBackground = (
                                    <img alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" src={provider.media.src} />
                                );
                            }

                            return (
                                <motion.div
                                    className={cn("group relative min-h-[200px] overflow-hidden", provider.gridClass)}
                                    key={provider.name}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={scaleUp}
                                >
                                    {mediaBackground}
                                    <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/30 to-transparent" />
                                    <div className="relative flex h-full flex-col justify-between p-5">
                                        <div>
                                            {"icon" in provider && provider.icon ? (
                                                <provider.icon className="text-white" size={28} />
                                            ) : (
                                                <h3 className="text-base font-semibold text-white">{provider.name}</h3>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {provider.models.map((model) => (
                                                <span
                                                    className="bg-brand-white/10 flex flex-col rounded-lg px-3 py-1.5 text-xs backdrop-blur-sm"
                                                    key={model.name}
                                                >
                                                    <span className="font-medium text-white/90">{model.name}</span>
                                                    <span className="text-[10px] text-white/50">{i18n._(model.desc)}</span>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            );
                        })}
                    </motion.div>
                </section>
            </div>
            {/* END DARK ZONE */}

            {/* ================================================================ */}
            {/* LIGHT ZONE: Features → Benefits */}
            {/* ================================================================ */}
            <div data-nav-theme="light">
                {/* ---------------------------------------------------------------- */}
                {/* 02 — Features Tabs (light) */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={2} light title={t`Features`} />

                <section className="bg-brand-white" id="features">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Chat, create, <span className="text-primary">and build.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">
                                    {t`Go from idea to finished output without switching tools. Text, images, video, and documents — one thread.`}
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
                                                <LinkButton size="marketing" to="/chat" variant="marketing">
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
                {/* 03 — Benefits */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={3} light title={t`Benefits`} />

                <section className="bg-brand-white">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Why <span className="text-primary">Neore.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">{t`Stop juggling subscriptions. One workspace, every model, one price.`}</p>
                            </div>
                        </FadeIn>

                        <motion.div
                            className="border-brand-silver grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-3"
                            initial="hidden"
                            variants={staggerContainer}
                            viewport={{ margin: "-60px", once: true }}
                            whileInView="visible"
                        >
                            {benefits.map((benefit, index) => (
                                <motion.div
                                    className={cn(
                                        "border-brand-silver border-b px-4 py-8 sm:px-6 sm:py-10 lg:px-10",
                                        index % 2 !== 0 && "sm:border-brand-silver sm:border-l lg:border-l-0",
                                        index % 3 !== 0 && "lg:border-brand-silver lg:border-l",
                                    )}
                                    key={benefit.title.id}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                >
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
                                            <benefit.icon className="size-4" />
                                        </div>
                                        <span className="text-primary font-mono text-xs font-medium tracking-widest uppercase">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                    </div>
                                    <h3 className="text-brand-obsidian mb-2 text-lg font-bold">{i18n._(benefit.title)}</h3>
                                    <p className="text-brand-graphite text-sm leading-relaxed">{i18n._(benefit.description)}</p>
                                </motion.div>
                            ))}
                        </motion.div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* ================================================================ */}
            {/* DARK ZONE: Mid-page CTA (primary bg) */}
            {/* ================================================================ */}
            <div data-nav-theme="dark">
                {/* ---------------------------------------------------------------- */}
                {/* 04 — Mid-page CTA */}
                {/* ---------------------------------------------------------------- */}
                <section className="bg-primary border-brand-silver -mt-px border-t">
                    <div className="border-primary/20 container mx-auto px-4 py-14 text-center sm:px-6 sm:py-20 lg:px-10">
                        <FadeIn variant="scale">
                            <h2 className="text-primary-foreground mb-3 text-2xl font-bold sm:text-3xl md:text-4xl">{t`Stop paying for six AI tools.`}</h2>
                            <p className="text-primary-foreground/70 mx-auto mb-6 max-w-md text-sm sm:mb-8 sm:text-base">
                                {t`30+ models, one workspace, one price. Free to start — no credit card required.`}
                            </p>
                            <motion.div className="inline-block" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                <LinkButton size="marketing" to="/chat" variant="marketing">
                                    {t`Start chatting free`} <ArrowRight className="ml-2 size-4" />
                                </LinkButton>
                            </motion.div>
                        </FadeIn>
                    </div>
                </section>
            </div>
            {/* END DARK ZONE */}

            {/* ================================================================ */}
            {/* LIGHT ZONE: Platform → Use Cases → Pricing */}
            {/* ================================================================ */}
            <div data-nav-theme="light">
                {/* ---------------------------------------------------------------- */}
                {/* 05 — Platform */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={5} light title={t`Platform`} />

                <section className="bg-brand-white">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Everything built <span className="text-primary">in.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite mx-auto max-w-lg text-base sm:text-lg">
                                    {t`Research, code, create, and connect — without leaving the conversation.`}
                                </p>
                            </div>
                        </FadeIn>

                        <motion.div
                            className="border-brand-silver grid grid-cols-1 border-t sm:grid-cols-2 lg:grid-cols-4"
                            initial="hidden"
                            variants={staggerContainer}
                            viewport={{ margin: "-60px", once: true }}
                            whileInView="visible"
                        >
                            {platformTools.map((tool, index) => (
                                <motion.div
                                    className={cn(
                                        "border-brand-silver border-b px-4 py-6 sm:px-6 sm:py-10",
                                        index % 2 !== 0 && "sm:border-brand-silver sm:border-l lg:border-l-0",
                                        index % 4 !== 0 && "lg:border-brand-silver lg:border-l",
                                    )}
                                    key={tool.name.id}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                >
                                    <div className="flex items-center gap-3 sm:block">
                                        <div className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md sm:mb-3">
                                            <tool.icon className="size-4" />
                                        </div>
                                        <div className="min-w-0">
                                            <span className="text-brand-obsidian block text-sm font-medium">{i18n._(tool.name)}</span>
                                            <span className="text-brand-graphite mt-0.5 block text-xs sm:mt-1">{i18n._(tool.description)}</span>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </motion.div>

                        <div className="border-brand-silver flex flex-col items-center justify-center gap-3 px-4 py-8 sm:flex-row sm:px-6 sm:py-10 lg:px-10">
                            <LinkButton size="marketing" to="/chat" variant="marketing">
                                {t`Start chatting free`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`See all features`}
                            </Button>
                        </div>
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 06 — Use Cases */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={6} light title={t`Use Cases`} />

                <section className="bg-brand-white">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 max-w-lg text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Built for <span className="text-primary">real workflows.</span>
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite max-w-lg text-base sm:text-lg">
                                    {t`See how teams use Neore to replace their entire AI stack.`}
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
                            {USE_CASES.map((useCase, index) => (
                                <motion.div
                                    className={cn(
                                        "border-brand-silver border-b px-4 py-8 sm:px-6 sm:py-10 lg:px-10",
                                        index % 2 !== 0 && "sm:border-brand-silver sm:border-l lg:border-l-0",
                                        index % 3 !== 0 && "lg:border-brand-silver lg:border-l",
                                    )}
                                    key={useCase.title.id}
                                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                                    variants={fadeUp}
                                >
                                    <div className="mb-5 flex items-center gap-3">
                                        <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md">
                                            <useCase.icon className="size-4" />
                                        </div>
                                        <span className="text-primary font-mono text-xs font-medium tracking-widest uppercase">
                                            {String(index + 1).padStart(2, "0")}
                                        </span>
                                    </div>
                                    <h3 className="text-brand-obsidian mb-2 text-lg font-bold">{i18n._(useCase.title)}</h3>
                                    <p className="text-brand-graphite text-sm leading-relaxed">{i18n._(useCase.description)}</p>
                                </motion.div>
                            ))}
                        </motion.div>
                        <LazyImage alt="" aspectRatioClassName="border-none" ratio={16} src={hero} />
                    </div>
                </section>

                {/* ---------------------------------------------------------------- */}
                {/* 07 — Pricing */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={7} light title={t`Pricing`} />

                <section className="bg-brand-white" id="pricing">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Simple, transparent <span className="text-primary">pricing</span>.
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite mx-auto mb-6 max-w-lg text-base sm:mb-8 sm:text-lg">
                                    {t`20 free messages a day to start. No credit card required. Upgrade when you're ready, cancel anytime.`}
                                </p>
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
                                                <span className="text-brand-obsidian font-mono text-4xl font-bold">${tier.monthlyPrice}</span>
                                                <span className="text-brand-graphite text-sm">/{i18n._(tier.priceUnit)}</span>
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

                                    {isSignedIn && (tier.id === "pro" || tier.id === "team") ? (
                                        <Button
                                            className="w-full"
                                            disabled={checkoutPending}
                                            onClick={() => {
                                                void startCheckout(tier.id === "team" ? "team" : "pro");
                                            }}
                                            size="marketing"
                                            variant={tier.popular ? "marketing" : "marketing-ghost"}
                                        >
                                            {t`Upgrade`}
                                        </Button>
                                    ) : (
                                        <LinkButton className="w-full" size="marketing" to={tier.href} variant={tier.popular ? "marketing" : "marketing-ghost"}>
                                            {i18n._(tier.cta)}
                                        </LinkButton>
                                    )}
                                </motion.div>
                            ))}
                        </motion.div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* ================================================================ */}
            {/* DARK ZONE: Get Started CTA */}
            {/* ================================================================ */}
            <div data-nav-theme="dark">
                {/* ---------------------------------------------------------------- */}
                {/* 08 — CTA */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={8} title={t`Get Started`} />

                <section>
                    <div className="relative container mx-auto border-x px-4 py-16 text-center sm:px-6 sm:py-28 lg:px-10">
                        <SectionSeperator />
                        <FadeIn variant="scale">
                            <h2 className="mb-3 text-3xl font-bold sm:mb-4 sm:text-4xl md:text-5xl">
                                <Trans>
                                    Your AI workspace <span className="text-primary">starts here.</span>
                                </Trans>
                            </h2>
                            <p className="mx-auto mb-6 max-w-md text-base text-white/50 sm:mb-8 sm:text-lg">
                                {t`30+ models. Images, video, code, and documents. 20 free messages a day — no credit card, cancel anytime.`}
                            </p>
                            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
                                <motion.div className="w-full sm:w-auto" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                                    <LinkButton size="marketing" to="/chat" variant="marketing">
                                        {t`Get started free`} <ArrowRight className="ml-2 size-4" />
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
                {/* ---------------------------------------------------------------- */}
                {/* 09 — FAQ */}
                {/* ---------------------------------------------------------------- */}
                <SectionBadge index={9} light title={t`FAQ`} />

                <section className="bg-brand-white" id="faq">
                    <div className="border-brand-silver container mx-auto border-x">
                        <FadeIn>
                            <div className="px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-28 sm:pb-16 lg:px-10">
                                <h2 className="text-brand-obsidian mb-3 text-3xl leading-tight font-bold tracking-tight sm:mb-4 sm:text-4xl md:text-5xl">
                                    <Trans>
                                        Frequently asked <span className="text-primary">questions</span>.
                                    </Trans>
                                </h2>
                                <p className="text-brand-graphite text-sm sm:text-base">{t`Everything you need to know about Neore.`}</p>
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
                            <LinkButton size="marketing" to="/chat" variant="marketing">
                                {t`Start chatting free`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                            <Button size="marketing" variant="marketing-ghost">
                                {t`Contact support`}
                            </Button>
                        </div>
                    </div>
                </section>
            </div>
            {/* END LIGHT ZONE */}

            {/* Footer (dark-ish bg) */}
            <div data-nav-theme="dark">
                <LandingFooter />
            </div>

            {/* Sticky Bar */}
            <LandingStickyBar visible={isSticky} />
        </div>
    );
};

export default LandingPage;
