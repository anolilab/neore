"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { BookOpen, Bot, Code, FileText, Globe, MessageSquare, Search, Sparkles, Zap } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import LandingFooter from "./landing-footer";
import Navbar from "./navbar-menu";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Tutorial {
    category: TutorialCategory;
    description: MessageDescriptor;
    icon: typeof BookOpen;
    slug: string;
    title: MessageDescriptor;
}

const TUTORIALS: Tutorial[] = [
    // Getting Started
    {
        category: "getting-started",
        description: msg`Create your account and send your first message. Learn about the chat interface, model selection, and basic settings.`,
        icon: MessageSquare,
        slug: "first-chat",
        title: msg`Your First Chat`,
    },
    {
        category: "getting-started",
        description: msg`Explore search modes, deep research, web search, academic search, and how to get the best results from each.`,
        icon: Search,
        slug: "search-modes",
        title: msg`Using Search Modes`,
    },
    {
        category: "getting-started",
        description: msg`Learn how to organize your conversations with tags, projects, pinning, and the sidebar.`,
        icon: FileText,
        slug: "organize-threads",
        title: msg`Organizing Threads`,
    },
    // Advanced Features
    {
        category: "advanced",
        description: msg`Enable Deep Work mode for complex multi-step tasks. The AI will iterate up to 25 times to complete your request.`,
        icon: Zap,
        slug: "deep-work",
        title: msg`Deep Work Mode`,
    },
    {
        category: "advanced",
        description: msg`Create documents, presentations, spreadsheets, and code artifacts directly in the chat canvas.`,
        icon: FileText,
        slug: "canvas-artifacts",
        title: msg`Canvas & Artifacts`,
    },
    {
        category: "advanced",
        description: msg`Upload files to the knowledge base for AI-powered search and retrieval across your conversations.`,
        icon: BookOpen,
        slug: "knowledge-base",
        title: msg`Knowledge Base & RAG`,
    },
    {
        category: "advanced",
        description: msg`Use the AI memory system to remember preferences, facts, and context across conversations.`,
        icon: Sparkles,
        slug: "memory-system",
        title: msg`AI Memory System`,
    },
    // Integrations
    {
        category: "integrations",
        description: msg`Connect Telegram, Slack, or Discord bots to chat with AI directly from your messaging apps.`,
        icon: Globe,
        slug: "messenger-bots",
        title: msg`Messenger Bots`,
    },
    {
        category: "integrations",
        description: msg`Set up triggers to automate tasks on a schedule, via webhooks, or in response to events.`,
        icon: Zap,
        slug: "triggers-automation",
        title: msg`Triggers & Automation`,
    },
    {
        category: "integrations",
        description: msg`Import your chat history from ChatGPT, Gemini, or Claude into Neore.`,
        icon: FileText,
        slug: "chat-import",
        title: msg`Chat Import`,
    },
    // Developer
    {
        category: "developer",
        description: msg`Run code in a sandboxed environment with shell access, file operations, and persistent sessions.`,
        icon: Code,
        slug: "sandbox-execution",
        title: msg`Sandbox & Code Execution`,
    },
    {
        category: "developer",
        description: msg`Use browser automation to navigate websites, extract data, take screenshots, and interact with web pages.`,
        icon: Globe,
        slug: "browser-automation",
        title: msg`Browser Automation`,
    },
    {
        category: "developer",
        description: msg`Bring your own API keys for AI providers and tools. Manage encrypted keys in settings.`,
        icon: Bot,
        slug: "byok",
        title: msg`Bring Your Own Keys (BYOK)`,
    },
];

const CATEGORIES = ["all", "getting-started", "advanced", "integrations", "developer"] as const;

type TutorialCategory = Exclude<(typeof CATEGORIES)[number], "all">;

const CATEGORY_LABELS: Record<(typeof CATEGORIES)[number], MessageDescriptor> = {
    advanced: msg`Advanced Features`,
    all: msg`All`,
    developer: msg`Developer`,
    "getting-started": msg`Getting Started`,
    integrations: msg`Integrations`,
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const TutorialCard = ({ tutorial }: { tutorial: Tutorial }) => {
    const { i18n } = useLingui();
    const Icon = tutorial.icon;

    return (
        <motion.div
            className={cn(
                "group relative flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6",
                "transition-colors hover:border-white/20 hover:bg-white/[0.06]",
            )}
            initial={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.4 }}
            viewport={{ once: true }}
            whileInView={{ opacity: 1, y: 0 }}
        >
            <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-white/10">
                    <Icon aria-hidden="true" className="size-5 text-white/70" />
                </div>
                <span className="text-xs font-medium tracking-wider text-white/40 uppercase">{i18n._(CATEGORY_LABELS[tutorial.category])}</span>
            </div>
            <h3 className="text-lg font-semibold text-white">{i18n._(tutorial.title)}</h3>
            <p className="text-sm leading-relaxed text-white/60">{i18n._(tutorial.description)}</p>
        </motion.div>
    );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const TutorialsPage = () => {
    const { i18n, t } = useLingui();
    const [activeCategory, setActiveCategory] = useState<(typeof CATEGORIES)[number]>("all");

    const filteredTutorials = activeCategory === "all" ? TUTORIALS : TUTORIALS.filter((tutorial) => tutorial.category === activeCategory);

    return (
        <div className="min-h-screen bg-black text-white">
            <Navbar />

            <main className="mx-auto max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
                {/* Header */}
                <motion.div animate={{ opacity: 1, y: 0 }} className="mb-16 text-center" initial={{ opacity: 0, y: 20 }} transition={{ duration: 0.5 }}>
                    <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
                        <Trans>Tutorials</Trans>
                    </h1>
                    <p className="mx-auto max-w-2xl text-lg text-white/60">
                        <Trans>Learn how to get the most out of Neore Chat. From your first conversation to advanced automation and integrations.</Trans>
                    </p>
                </motion.div>

                {/* Category Filter */}
                <div aria-label={t`Tutorial categories`} className="mb-12 flex flex-wrap justify-center gap-2" role="tablist">
                    {CATEGORIES.map((category) => (
                        <button
                            aria-selected={activeCategory === category}
                            className={cn(
                                "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                                activeCategory === category ? "bg-white text-black" : "bg-white/10 text-white/60 hover:bg-white/15 hover:text-white/80",
                            )}
                            key={category}
                            onClick={() => setActiveCategory(category)}
                            role="tab"
                            type="button"
                        >
                            {i18n._(CATEGORY_LABELS[category])}
                        </button>
                    ))}
                </div>

                {/* Tutorial Grid */}
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" role="tabpanel">
                    {filteredTutorials.map((tutorial) => (
                        <TutorialCard key={tutorial.slug} tutorial={tutorial} />
                    ))}
                </div>

                {/* Help CTA */}
                <motion.div className="mt-20 text-center" initial={{ opacity: 0 }} viewport={{ once: true }} whileInView={{ opacity: 1 }}>
                    <p className="text-white/40">
                        <Trans>
                            Need more help? Check the{" "}
                            <a className="text-white/60 underline underline-offset-4 transition-colors hover:text-white" href="/docs">
                                documentation
                            </a>{" "}
                            or reach out in the chat.
                        </Trans>
                    </p>
                </motion.div>
            </main>

            <LandingFooter />
        </div>
    );
};

export default TutorialsPage;
