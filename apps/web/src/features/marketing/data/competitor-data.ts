/**
 * Single source of truth for competitor / alternative comparison pages.
 *
 * Each competitor object powers both:
 *  - The `/vs/{slug}` head-to-head page (full data used).
 *  - The `/alternatives` index card (summary fields used).
 *
 * Source data: docs/analyze/competitor-analysis.md
 */

export type FeatureSupport = "yes" | "no" | "partial";

export type ComparisonRow = {
    /** Short label, e.g. "Multi-provider models" */
    feature: string;
    /** What Neore offers (label rendered next to icon) */
    neore: { support: FeatureSupport; note?: string };
    /** What the competitor offers */
    competitor: { support: FeatureSupport; note?: string };
};

export type PricingTier = {
    name: string;
    /** e.g. "$0", "$20/mo", "$8/mo flat" */
    price: string;
    /** e.g. "Free tier with limits" */
    description?: string;
    /** Key inclusions, max ~4 bullets */
    highlights?: string[];
};

export type Competitor = {
    /** URL slug. Used in /vs/{slug} and /alternatives/{slug}. */
    slug: string;
    /** Display name */
    name: string;
    /** One-line tagline (the competitor's own pitch, paraphrased) */
    tagline: string;
    /** One-line summary for index cards, our voice */
    summary: string;
    /** "US", "DE", "FR", "CN", etc. */
    country: string;
    /** Optional founder/maintainer label */
    by?: string;
    /** Year launched */
    yearLaunched?: number;
    /** Category badge */
    category: "hosted-chat" | "byok-desktop" | "open-source" | "incumbent" | "agent" | "search" | "eu-sovereign";

    /** Where it sits relative to Neore */
    overlap: "direct" | "adjacent" | "indirect";

    /** TL;DR positioning paragraph for the top of the /vs page */
    tldr: string;

    /** Quick spec at a glance */
    spec: {
        models: string;
        byok: boolean;
        euResidency: "yes" | "no" | "enterprise-only" | "partial";
        hosting: "hosted" | "self-hosted" | "desktop" | "hybrid";
        mobileApp: boolean;
    };

    /** Pricing tiers */
    pricing: PricingTier[];

    /** Bullets — be honest, max 4 each */
    strengths: string[];
    weaknesses: string[];

    /** Bullets used in the "When to choose..." comparison */
    whenToChoose: {
        them: string[];
        us: string[];
    };

    /** Structured feature comparison */
    features: ComparisonRow[];

    /** FAQs powering FAQPage schema + accordion UI */
    faqs: { q: string; a: string }[];

    /** Sources for verifiability — cited in the page footer */
    sources: { label: string; url: string }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const yes = (note?: string): ComparisonRow["neore"] => ({ support: "yes", note });
const no = (note?: string): ComparisonRow["neore"] => ({ support: "no", note });
const partial = (note?: string): ComparisonRow["neore"] => ({ support: "partial", note });

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

const t3Chat: Competitor = {
    slug: "t3-chat",
    name: "T3.chat",
    tagline: "The fastest AI chatbot — flat $8/mo, branching, multi-model.",
    summary: "Theo Browne's YC-backed $8/mo chat. Fast, branching, ~20 models. No memory, no triggers, no mobile, no EU posture.",
    country: "US",
    by: "Theo Browne / T3 Tools, Inc.",
    yearLaunched: 2024,
    category: "hosted-chat",
    overlap: "direct",
    tldr: "T3.chat excels at speed and a flat $8/mo price with branching conversations — built by a popular creator with a clear aesthetic. Neore Chat is built for users who hit the limits of that simplicity: 10× the model breadth, persistent memory, triggers and webhooks, browser automation, messenger ingress, and a GDPR-focused posture. Choose T3 if you want the fastest, cheapest single-purpose chat. Choose Neore if you want everything around the chat too.",
    spec: {
        models: "~20 frontier + open models",
        byok: true,
        euResidency: "no",
        hosting: "hosted",
        mobileApp: false,
    },
    pricing: [
        {
            name: "Free",
            price: "$0",
            description: "Limited messages on basic models.",
        },
        {
            name: "Pro",
            price: "$8/mo flat",
            description: "Usage-bar model (overhauled Feb 2026).",
            highlights: [
                "Single usage bar that resets every 4 hours",
                "BYOK messages don't count toward the bar",
                "MCP, web search, branching, image gen",
                "100 Claude messages/mo sub-cap",
            ],
        },
        {
            name: "Claude top-up",
            price: "$8 / 100 messages",
            description: "Add-on credit pack.",
        },
    ],
    strengths: [
        "Cleanest UX in the BYOK chat category",
        "Branching conversations users love",
        "Massive creator-led distribution (Theo's audience)",
        "True flat pricing — no compute-point roulette",
    ],
    weaknesses: [
        "No persistent cross-thread memory (frequently cited deal-breaker)",
        "No native mobile app",
        "No automation, triggers, or messenger integrations",
        "No EU residency story — Azure-hosted",
    ],
    whenToChoose: {
        them: [
            "You want the cheapest, fastest single-purpose chat",
            "You're already in Theo's community and trust the roadmap",
            "You don't need memory, automation, or mobile",
            "You only chat in the browser",
        ],
        us: [
            "You hit walls on T3's model selection or message cap",
            "You want the AI to remember facts about you across sessions",
            "You want to trigger AI runs on a schedule or via Telegram / Slack / Discord",
            "You're in the EU and want a verifiable data-residency story",
        ],
    },
    features: [
        { feature: "Frontier model selection", neore: yes("280+ models via gateway"), competitor: partial("~20 curated models") },
        { feature: "Bring your own keys (BYOK)", neore: yes("All providers"), competitor: yes("Uncaps message limit") },
        { feature: "Persistent memory across threads", neore: yes("Multi-signal scoring + belief revision"), competitor: no() },
        { feature: "Branching conversations", neore: yes(), competitor: yes("Signature feature") },
        { feature: "MCP support", neore: yes(), competitor: yes() },
        { feature: "Web search built-in", neore: yes(), competitor: yes() },
        { feature: "Image generation", neore: yes(), competitor: yes() },
        { feature: "Canvas / artifacts (docs, sheets, code, design)", neore: yes("Including spreadsheet & design canvas"), competitor: no() },
        { feature: "Browser automation tool", neore: yes("Browserbase + Playwright"), competitor: no() },
        { feature: "Scheduled triggers / webhooks", neore: yes("Cron + webhook"), competitor: no() },
        { feature: "Deep Work auto-continue", neore: yes("Up to 25 iterations"), competitor: no() },
        { feature: "Messenger ingress (Telegram / Slack / Discord)", neore: yes(), competitor: no() },
        { feature: "Mobile native app", neore: no("Responsive web only"), competitor: no() },
        {
            feature: "GDPR rights (export, deletion, audit log)",
            neore: yes("Implemented; DPA and sub-processor list on roadmap"),
            competitor: no("US Azure, no DPA"),
        },
        { feature: "Organizations / teams / RBAC", neore: yes("Better Auth + orgs"), competitor: no() },
    ],
    faqs: [
        {
            q: "Is Neore Chat a T3.chat alternative?",
            a: "Yes. Both are BYOK multi-model chat apps. Neore offers ~14× the model breadth (280+ vs ~20), adds persistent memory, triggers and webhooks, messenger ingress, browser automation, canvas artifacts (including spreadsheets and design), and implements GDPR rights (data export, deletion, audit log). T3 wins on speed-of-iteration UX and a tighter brand.",
        },
        {
            q: "How does pricing compare?",
            a: "T3 charges $8/mo flat with a usage bar that resets every 4 hours (overhauled February 2026; BYOK messages don't count toward it). Neore offers a Free tier, a managed Pro plan, and BYOK mode that pays providers directly through the Neore Gateway with no platform markup. If you use BYOK heavily, Neore's BYOK economics typically match or beat T3.",
        },
        {
            q: "Is T3.chat GDPR-compliant?",
            a: "T3.chat is operated by T3 Tools, Inc. (US) and hosted on Azure. It has no published EU data-residency or DPA documentation. EU users with regulatory or organizational data-residency requirements should evaluate carefully.",
        },
        {
            q: "Does T3.chat have a mobile app?",
            a: "No. T3.chat is browser-only. A native mobile app is one of the most-requested items in their feedback board. Neore also does not yet ship a native mobile app (responsive web only) — this is honest parity, not a Neore advantage.",
        },
        {
            q: "What does Neore have that T3 doesn't?",
            a: "Persistent memory with belief revision, scheduled triggers and webhook triggers, Deep Work auto-continue (up to 25 iterations), browser automation, messenger ingress (Telegram / Slack / Discord), canvas artifacts (documents, spreadsheets, code, design canvas), MCP servers, organizations and RBAC, GDPR rights wired in, and 280+ models via the gateway.",
        },
    ],
    sources: [
        { label: "T3 Chat — Y Combinator", url: "https://www.ycombinator.com/companies/t3-chat" },
        {
            label: "T3 Chat pricing review (Skywork)",
            url: "https://skywork.ai/skypage/en/T3-Chat-Pricing-Is-the-$8-AI-Powerhouse-Too-Good-to-Be-True/1974387624371744768",
        },
        { label: "T3 Chat comprehensive review (bmateas)", url: "https://bmateas.com/blog/t3-chat-comprehensive-review" },
        { label: "Theo on usage-bar overhaul (Feb 14 2026)", url: "https://x.com/theo/status/2022844310165893484" },
        { label: "T3 Chat feedback board", url: "https://feedback.t3.chat/" },
    ],
};

// ---------------------------------------------------------------------------
// Index / cards
// ---------------------------------------------------------------------------

/**
 * Lightweight card data for the /alternatives index hub.
 * Heavy competitors get full Competitor objects (above); these are
 * one-liners pointing at future /vs/{slug} pages.
 */
export type CompetitorCard = {
    slug: string;
    name: string;
    summary: string;
    category: Competitor["category"];
    /** "yes" | "no" | "partial" — used for at-a-glance badges on the index */
    byok: boolean;
    euResidency: Competitor["spec"]["euResidency"];
};

const cardFrom = (c: Competitor): CompetitorCard => ({
    slug: c.slug,
    name: c.name,
    summary: c.summary,
    category: c.category,
    byok: c.spec.byok,
    euResidency: c.spec.euResidency,
});

/**
 * All competitor cards (used by /alternatives index). Full Competitor
 * objects exist only for those with built /vs/{slug} pages.
 */
export const ALL_COMPETITOR_CARDS: CompetitorCard[] = [
    cardFrom(t3Chat),
    // Direct BYOK alternatives — pages coming
    {
        slug: "typingmind",
        name: "TypingMind",
        summary: "Polished BYOK frontend with lifetime licensing ($39–$99). 12 providers, MCP, Characters. Bug rate + support quality flagged in reviews.",
        category: "byok-desktop",
        byok: true,
        euResidency: "no",
    },
    {
        slug: "msty",
        name: "Msty",
        summary: "Local-first desktop ($99/yr or $199 lifetime). Best Ollama UX, Split Chats, Knowledge Stacks, closed-source.",
        category: "byok-desktop",
        byok: true,
        euResidency: "no",
    },
    // Open-source self-hosted
    {
        slug: "librechat",
        name: "LibreChat",
        summary: "MIT, 37k stars. Best enterprise auth (LDAP/OIDC), MCP-first, Code Interpreter. Self-host complexity is the trade-off.",
        category: "open-source",
        byok: true,
        euResidency: "partial",
    },
    {
        slug: "open-webui",
        name: "Open WebUI",
        summary:
            "~139k stars. Best Ollama UX, mature scaling (SCIM, OTel). License changed in v0.6.6 (April 2025) — branding-retention clause for >50-user deployments triggered community backlash and fork talk.",
        category: "open-source",
        byok: true,
        euResidency: "partial",
    },
    // Market leaders
    {
        slug: "chatgpt",
        name: "ChatGPT",
        summary:
            "OpenAI's market leader. Free / Go $8 / Plus $20 / Pro $100 or $200 / Business $25 annual or $30 monthly per seat / Enterprise ~$40+/seat. No MCP. EU residency Enterprise-only.",
        category: "incumbent",
        byok: false,
        euResidency: "enterprise-only",
    },
    {
        slug: "claude",
        name: "Claude.ai",
        summary:
            "Anthropic. Pro $20 / Max $100–$200 / Team $25–$125. First-class MCP, Artifacts, Computer Use. Severe rate-limit complaints; M365 path routes to US AWS.",
        category: "incumbent",
        byok: false,
        euResidency: "partial",
    },
    // EU-native
    {
        slug: "le-chat",
        name: "Le Chat (Mistral)",
        summary:
            "French sovereign AI. Pro €14.99/$14.99 monthly · Team €24.99/$24.99 monthly (€19.99 annual) · Enterprise on-prem. Mistral-only models (no BYOK).",
        category: "eu-sovereign",
        byok: false,
        euResidency: "yes",
    },
    {
        slug: "aleph-alpha",
        name: "Aleph Alpha (Pharia)",
        summary:
            "German enterprise/government chat on PhariaAI sovereign stack. STACKIT EU01 hosting. Sales-led, no BYOK or prosumer tier. Note: Cohere merger announced April 2026 — corporate structure in flux.",
        category: "eu-sovereign",
        byok: false,
        euResidency: "yes",
    },
    {
        slug: "ionos-gpt",
        name: "IONOS ionosGPT",
        summary: "German GDPR-compliant chat on IONOS infra. Open-weights only; weak agent surface vs. Neore.",
        category: "eu-sovereign",
        byok: false,
        euResidency: "yes",
    },
    // Multi-model / search
    {
        slug: "poe",
        name: "Poe",
        summary: "Quora's aggregator. 1,000s of bots with creator revenue share. Compute-point pricing is the common complaint.",
        category: "hosted-chat",
        byok: false,
        euResidency: "no",
    },
    {
        slug: "perplexity",
        name: "Perplexity",
        summary: "Answer engine + Comet agentic browser + Labs. Pro $20 / Max $200 / Enterprise $40–$325/seat. Citation accuracy complaints.",
        category: "search",
        byok: false,
        euResidency: "no",
    },
    // Open / free
    {
        slug: "huggingchat",
        name: "HuggingChat",
        summary: "Free, no login. Open-weights playground from Hugging Face. No memory, no MCP, no mobile, no EU claims.",
        category: "open-source",
        byok: false,
        euResidency: "no",
    },
    // Pure autonomous agent
    {
        slug: "manus",
        name: "Manus",
        summary:
            "Autonomous agent by Butterfly Effect (Singapore HQ, Beijing-origin team). Credit-based pricing ($20 / $40 / $200 per month). Meta's ~$2B acquisition was blocked by China (NDRC) on April 27, 2026 on national security grounds. Outbound traffic traced to Shenzhen servers by independent researchers; no published EU data-residency.",
        category: "agent",
        byok: false,
        euResidency: "no",
    },
    // BYOK desktop OSS
    {
        slug: "witsy",
        name: "Witsy",
        summary: "AGPL-3.0 French desktop BYOK client. 15+ providers + Ollama + MCP. Free. No monetization.",
        category: "byok-desktop",
        byok: true,
        euResidency: "partial",
    },
    {
        slug: "jan",
        name: "Jan.ai",
        summary: "Apache-2.0 Electron app. Local llama.cpp + BYOK for cloud. Singapore HQ, frequently recommended in EU privacy circles.",
        category: "byok-desktop",
        byok: true,
        euResidency: "partial",
    },
    {
        slug: "big-agi",
        name: "Big-AGI",
        summary: "Local-first multi-model OSS workspace. BYOK. Hosted Pro at $10.99/mo funds the OSS project.",
        category: "open-source",
        byok: true,
        euResidency: "partial",
    },
    {
        slug: "lobechat",
        name: "LobeChat",
        summary: "OSS multi-provider chat. Self-host friendly. CN origin — EU privacy/policy buyers should evaluate carefully.",
        category: "open-source",
        byok: true,
        euResidency: "partial",
    },
    {
        slug: "cherry-studio",
        name: "Cherry Studio",
        summary: "AGPL-3.0 desktop. 300+ models, 50+ providers, local-only data. CN origin.",
        category: "byok-desktop",
        byok: true,
        euResidency: "partial",
    },
];

/**
 * Map slug → full Competitor (for routes that have full /vs/{slug} pages).
 */
export const COMPETITORS_BY_SLUG: Record<string, Competitor> = {
    [t3Chat.slug]: t3Chat,
};

/**
 * Get a competitor by slug or undefined.
 */
export const getCompetitor = (slug: string): Competitor | undefined => COMPETITORS_BY_SLUG[slug];

/**
 * Slugs of competitors with full /vs/{slug} pages built today.
 * Used to decide whether a card on the index links to a real page or shows "coming soon".
 */
export const BUILT_VS_SLUGS = new Set<string>(Object.keys(COMPETITORS_BY_SLUG));
