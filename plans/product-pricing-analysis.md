# Neore Product & Pricing Analysis

*Date: 2026-03-11*
*Status: Draft for review*

---

## 1. Executive Summary

Neore is an AI workspace that aggregates 30+ models across text, image, video, code, and research into one subscription. The current pricing ($20/mo Pro) undercharges relative to the value delivered and the cost structure. This document analyzes every feature, maps them to five product pillars, estimates unit economics, and proposes a revised tier structure designed to maximize conversion while protecting margins on expensive operations.

---

## 2. Complete Feature Inventory

### 2.1 Text Chat (30+ LLMs)

| Model Family | Examples | Provider Cost Profile |
|---|---|---|
| Anthropic Claude | Haiku 4.5, Sonnet 4/4.5/4.6, Opus 4/4.1/4.5/4.6 | $0.25-$75/MTok via OpenRouter |
| OpenAI GPT | GPT-4o, GPT-4.1, o1, o3, o4-mini | $1-$60/MTok via OpenRouter |
| Google Gemini | 2.5 Flash, 2.5 Pro | $0.075-$10/MTok via OpenRouter |
| xAI Grok | Grok 3, Grok 3 mini | $3-$15/MTok via OpenRouter |
| Meta Llama | Llama 3.1 8B (free) | Free tier via OpenRouter |
| Moonshot | Kimi K2 | Low cost via OpenRouter |
| Mistral | Devstral 2 | Low cost via OpenRouter |
| Qwen | Qwen3-8B (free) | Free tier via OpenRouter |
| Google Gemma | Gemma3-8B (free) | Free tier via OpenRouter |
| DeepSeek | R1 | Low cost via OpenRouter |

**Premium text models** (marked `isPremium`): o1, o3, Opus 4.5 — these cost 5-15x more per token than standard models.

### 2.2 Image Generation (10+ models)

| Model | Provider | Cost per Image (est.) |
|---|---|---|
| Gemini 2.5 Flash Image | OpenRouter/Google | ~$0.01-0.03 |
| FLUX Pro / FLUX 2 Pro | FAL (BFL) | ~$0.04-0.06 |
| FLUX Dev | FAL | ~$0.02-0.04 |
| SDXL Lightning | FAL | ~$0.01-0.02 |
| Nano Banana | FAL | ~$0.01 |
| GPT Image 1 | OpenAI | ~$0.02-0.08 |
| Grok 2 Image | xAI | ~$0.03-0.05 |
| Imagen 4.0 | Google | ~$0.04-0.06 |
| Ideogram 3 | Replicate | ~$0.04-0.06 |
| FLUX Pro 1.1 Ultra | BFL | ~$0.06-0.10 |

**Advanced image capabilities**: img2img, upscaling, inpainting, outpainting, background removal, object removal, ControlNet (pose/depth/canny), character reference, style reference.

### 2.3 Video Generation (8+ models)

| Model | Provider | Cost per Video (est.) |
|---|---|---|
| Seedance v1.5 Pro (t2v/i2v) | FAL (ByteDance) | ~$0.10-0.40 |
| Kling v3.0 (t2v/i2v) | Kling AI | ~$0.20-0.50 |
| Wan v2.1 (1080p t2v) | FAL | ~$0.15-0.30 |
| Wan v2.1 (i2v) | FAL | ~$0.10-0.20 |
| Luma Ray2 Flash | FAL/Replicate | ~$0.10-0.25 |
| Mochi v1 | FAL | ~$0.10-0.20 |
| Video-to-video | FAL | ~$0.10-0.30 |

**Cost note**: Video generation is the most expensive feature. A single 10-second video can cost $0.20-0.50 in API costs.

### 2.4 Audio (Speech)

| Capability | Provider | Cost |
|---|---|---|
| Speech-to-text (Whisper/Wizper) | FAL | ~$0.006/min |
| Text-to-speech (MiniMax Speech 02 HD) | FAL | ~$0.01/1K chars |

### 2.5 Search Modes (13 modes)

| Mode | External API Dependencies | Cost Profile |
|---|---|---|
| Chat | None (direct LLM) | Token cost only |
| Writing | None | Token cost only |
| Web | Search API + retrieve | ~$0.005-0.01/search |
| Academic | Academic search API | ~$0.005/search |
| Wolfram | Wolfram Alpha API | ~$0.01/query |
| X/Twitter | X API | ~$0.005/search |
| Reddit | Reddit API | ~$0.005/search |
| YouTube | YouTube API | Free (quota-based) |
| Stocks | Financial APIs | ~$0.005/query |
| Crypto | CoinGecko API | Free tier |
| Code | Stack Overflow API | Free |
| GitHub | GitHub API | Free (quota-based) |
| Spotify | Spotify API | Free (quota-based) |

### 2.6 Tools & Capabilities (40+ tools)

| Category | Tools | Cost Profile |
|---|---|---|
| **Documents** | createDocument, updateDocument, createPresentation, updateSlide | Token cost only |
| **Design Canvas** | createDesign, updateDesign (Fabric.js, 37 presets, 16 styles) | Token cost only |
| **Code Execution** | Python sandbox, shell execution, file operations | Sandbox compute cost |
| **Browser Automation** | 7 actions (navigate, screenshot, click, type, extract, scroll, evaluate) | Browserbase session ~$0.01-0.05/session |
| **Deep Research** | Multi-step automated research with citations | 3-10x token cost (multiple LLM calls) |
| **Image Editing** | Editing, vision analysis, deepfake detection | FAL API costs |
| **Image/Video Search** | Web image and video search | API costs |
| **Translation** | Text translation, language detection | Minimal |
| **Finance** | Stock charts, crypto data, currency conversion | Minimal |
| **Location** | Maps, nearby places, weather | API costs |
| **Entertainment** | Movie/TV search, trending media | Minimal |
| **Social** | People search, company search | API costs |
| **Memory** | Automatic fact extraction, retrieval | Embedding + LLM costs |
| **Knowledge Base** | RAG search across uploaded docs | Embedding costs |
| **Task List** | In-thread task management | Free |
| **Canvas AI** | AI-powered document editing | Token cost |

### 2.7 Platform Features

| Feature | Description | Cost Profile |
|---|---|---|
| **BYOK (Bring Your Own Key)** | Users supply their own API keys for providers | $0 (user pays directly) |
| **Messenger Integration** | Telegram, Slack, Discord bots with BYOK | Webhook infra only |
| **Triggers/Automation** | Schedule (cron), webhook, event-based | Compute + LLM costs per execution |
| **Auto-Continue (Deep Work)** | 25-step agent loops | 5x token cost |
| **Chat Import** | Import from ChatGPT, Gemini, Claude | One-time processing |
| **Organizations/Teams** | Shared threads, roles, SSO | Infra only |
| **Memory System** | Automatic learning across conversations | Embedding + extraction LLM |
| **Pins** | Pin messages with notes | Free |
| **Thread Branching** | Fork conversations at any point | Free |
| **Model Switching** | Change model mid-conversation | Free |
| **MCP Server Support** | External tool integration | Free |
| **File Uploads** | PDF, images, documents | Storage costs |
| **GDPR Compliance** | Data export, deletion | Free |
| **Skills System** | Reusable automation templates with slash commands, versioning | Free |
| **Vault / File Storage** | Folder hierarchy, NSFW detection, R2 storage | Storage costs |
| **MCP Connectors** | Built-in (Google Drive, Slack, GitHub, Notion) + custom servers | OAuth proxy infra |
| **Playground API** | Bearer token auth, key management for programmatic access | Infra only |
| **Community Gallery** | Public workflow publishing, forking, editorial picks | Free |
| **Follow-up Suggestions** | AI-generated reply chips after responses | LLM cost per generation |
| **Reasoning Models** | Extended thinking (Claude/Gemini/GPT with reasoning effort levels) | 2-5x token cost |
| **Dictation / Transcription** | Language-aware speech input per thread | FAL transcription costs |

---

## 3. Product Pillars

Based on your proposed categories and the feature inventory, here's how features map to five product pillars:

### Pillar 1: Chat & Research (core value prop)

> "One workspace, every AI model"

- 30+ text LLMs with mid-conversation model switching
- 13 search modes (web, academic, code, social, finance, etc.)
- Deep Research (multi-step automated analysis)
- Memory system (learns from conversations)
- Knowledge base (RAG over uploaded docs)
- Documents & presentations (canvas editor)
- File uploads and PDF analysis
- Translation
- Thread branching & conversation management
- Pins with notes
- Follow-up suggestions (AI reply chips)
- Reasoning models (extended thinking)
- Dictation / transcription

**This is the ChatGPT/Claude replacement pillar.** Most users will buy primarily for this.

### Pillar 2: Image & Video Generation (creative value)

> "Every image and video model in one place"

- 10+ image generation models (FLUX, SDXL, Imagen, GPT Image, Grok, Ideogram)
- 8+ video generation models (Seedance, Kling, Wan, Luma, Mochi)
- Advanced image editing (img2img, upscale, inpaint, outpaint, background removal)
- ControlNet (pose, depth, canny conditioning)
- Character/style reference
- Design canvas (37 platform presets, 16 styles)
- Vision analysis & deepfake detection
- Speech-to-text and text-to-speech

**This is the Midjourney/Runway replacement pillar.** High perceived value, high API cost.

### Pillar 3: Coding & Development

> "Code with AI, execute instantly"

- Python code execution sandbox
- Shell execution environment
- File operations in sandbox
- GitHub search
- Stack Overflow/code search
- Browser automation (Browserbase + Playwright)
- Coding-focused models (Devstral 2, Claude Sonnet)

**This is the Cursor/Replit replacement pillar.** Appeals to developer persona.

### Pillar 4: Workflow & Automation

> "AI that works while you sleep"

- Triggers: schedule (cron), webhook (HMAC-SHA256), event-based
- Auto-continue (Deep Work mode): 25-step agent loops
- Messenger bots (Telegram, Slack, Discord)
- Skills system (reusable slash-command automations with versioning)
- Task list management
- MCP connectors (built-in: Google Drive, Slack, GitHub, Notion + custom)
- Community gallery (publish, fork, share workflows)
- Chat import (migrate from other platforms)

**This is the Zapier/Make.com replacement for AI workflows.** High stickiness, high switching cost.

### Pillar 5: Teams & Enterprise

> "AI for your whole team"

- Organizations with roles & permissions
- Shared threads and conversations
- SSO integration
- BYOK (bring your own API keys)
- GDPR compliance & data export
- Centralized billing & credit pools
- Admin controls & usage analytics
- Vault (shared file storage with folder hierarchy)
- Playground API (programmatic access with bearer tokens)

**This is the upgrade path from individual to team.**

---

## 4. Cost-of-Goods-Sold (COGS) Analysis

### 4.1 Per-User Cost Estimates

Assuming a "moderate" user (daily usage, mix of features):

| Activity | Monthly Volume | Unit Cost | Monthly COGS |
|---|---|---|---|
| Text chat (standard models) | 500 messages | ~$0.005/msg avg | $2.50 |
| Text chat (premium models) | 50 messages | ~$0.05/msg avg | $2.50 |
| Web/search queries | 100 queries | ~$0.008/query | $0.80 |
| Image generation | 30 images | ~$0.04/image | $1.20 |
| Video generation | 5 videos | ~$0.25/video | $1.25 |
| Deep Research | 5 sessions | ~$0.15/session | $0.75 |
| Code execution | 20 runs | ~$0.01/run | $0.20 |
| Browser automation | 3 sessions | ~$0.03/session | $0.09 |
| Memory/embeddings | ongoing | ~$0.10/mo | $0.10 |
| Storage/infra | ongoing | ~$0.50/mo | $0.50 |
| **Total moderate user** | | | **~$9.89/mo** |

### 4.2 Heavy User COGS

| Activity | Monthly Volume | Unit Cost | Monthly COGS |
|---|---|---|---|
| Text chat (standard) | 2,000 messages | $0.005 | $10.00 |
| Text chat (premium) | 200 messages | $0.05 | $10.00 |
| Image generation | 200 images | $0.04 | $8.00 |
| Video generation | 30 videos | $0.25 | $7.50 |
| Deep Research | 20 sessions | $0.15 | $3.00 |
| Code/browser/other | varied | | $2.00 |
| Infra | | | $0.50 |
| **Total heavy user** | | | **~$41.00/mo** |

### 4.3 Key Insight

At $20/mo Pro pricing:
- **Light users**: ~$3-5 COGS → 75-85% margin (good)
- **Moderate users**: ~$10 COGS → 50% margin (acceptable)
- **Heavy users**: ~$25-41 COGS → **negative margin** (problem)

Video generation and premium text models are the biggest cost drivers. These must be gated or usage-limited.

---

## 5. Competitive Pricing Landscape (March 2026)

| Product | Free | Entry Paid | Power User | Team (per seat) | Enterprise |
|---|---|---|---|---|---|
| **ChatGPT** | Yes (GPT-5.2 Instant, ~10 msg/5hr) | Plus $20/mo | Pro $200/mo (unlimited) | $25-30/user/mo | Custom |
| **Claude** | Yes (limited Sonnet) | Pro $20/mo | Max $100-200/mo (5-20x Pro usage) | $25-150/user/mo | Custom |
| **Gemini** | Yes (Flash, 100 credits) | AI Pro $19.99/mo (1K credits) | AI Ultra ~$42/mo (25K credits) | $20-30/user/mo | $30-36/user/mo |
| **Perplexity** | Yes (~5-20 queries/day) | Pro $20/mo (300+ searches/day) | Max $200/mo (unlimited) | $40/seat/mo | $325/seat/mo |
| **T3 Chat** | Yes (select models, 100 premium reqs) | Pro $8/mo (1500 msg/mo, 100 Claude/mo) | Add-on credits ($8/100 Claude msgs) | N/A | Contact sales |
| **Midjourney** | No | Basic $10/mo (3.3 GPU hrs) | Pro $60/mo (30 hrs) | N/A | Mega $120/mo |
| **Cursor** | Yes (2K completions) | Pro $20/mo (credit pool) | Ultra $200/mo (20x credits) | $40/user/mo | Custom |
| **v0** | Yes ($5 credits) | Premium $20/mo | N/A | $30-100/user/mo | Custom |

### T3 Chat — Deep Dive (Closest Competitor)

T3 Chat (by Theo Browne / T3 Tools) is the most direct competitor to Neore's core "multi-model chat" value proposition. ~941K MAU.

**What T3 Chat does well:**
- **Price disruption**: $8/mo Pro undercuts every competitor by 60%+. This is the price anchor Neore will be compared against for pure chat.
- **Speed**: Claims 2x faster than ChatGPT, 10x faster than DeepSeek. Local-first architecture stores data on-device.
- **Clean UX**: Minimal, fast interface. Markdown, LaTeX, code highlighting, conversation branching, side-by-side model comparison.
- **Search integration**: Real-time web search grounding across most models.
- **Image generation**: GPT-Image-1 support for paid users (100 images/mo count as premium credits). Basic but functional.
- **File uploads**: Upload files for context in conversations.
- **Artifacts**: React/HTML code rendering, Mermaid diagrams in chat.
- **Model breadth**: GPT-5, Claude, Gemini 3, DeepSeek, Groq — 15+ models including GPT-Image-1. Similar roster to Neore.
- **Data sovereignty**: Local-first storage, import/export, optional cloud sync. Privacy-focused positioning.
- **Conversation organization**: Group chats by project/topic/workflow.

**What T3 Chat does NOT have (Neore's advantages):**
- No video generation (Neore has 8+ video models)
- No advanced image editing (no inpainting, upscaling, background removal, ControlNet, style transfer)
- No dedicated image models beyond GPT-Image-1 (Neore has FLUX, SDXL, Imagen, Ideogram, Grok)
- No code execution sandbox (no E2B or equivalent)
- No browser automation
- No triggers/automation/workflows
- No messenger bots (Telegram, Slack, Discord)
- No knowledge base / RAG
- No memory system (learns from conversations)
- No deep research (multi-step agent) — community-requested, not shipped
- No Deep Work mode (25-step agent loops)
- No design canvas (Fabric.js editor with 37 platform presets)
- No presentations/spreadsheets (Univer.js, XLSX, PowerPoint)
- No BYOK
- No teams/organizations
- No MCP connectors — web-only, no local server support
- No skills/automation marketplace
- No API access

**Strategic implication**: T3 Chat competes on price and speed for *pure chat*. Neore competes on *depth and breadth*. Don't try to match T3's $8 price — instead, justify the premium by highlighting the 15+ features T3 doesn't offer. The positioning should be: "T3 Chat is a fast chat interface. Neore is an AI workspace."

**Pricing response**: T3 now has basic image generation (GPT-Image-1, 100/mo), so Neore can't claim "no images" as a gap. But T3's image story is thin — one model, no editing, no video. Neore's Starter at $16-20/mo is justified because it includes 10+ image models, video generation, advanced editing, knowledge base, documents, code sandbox, and 13 search modes. Frame it as "$8 more gets you the full creative + research stack, not just chat with basic images."

### Key Market Trends (March 2026)

- **$20/mo is the universal entry price** for individual AI subscriptions (single-model products)
- **$8/mo is the new floor** for multi-model chat-only products (T3 Chat). This creates downward price pressure on pure chat value.
- **$200/mo "unlimited" tier** is becoming standard (ChatGPT Pro, Claude Max 20x, Cursor Ultra, Perplexity Max)
- **Credit/token-based systems** are replacing flat message counts (Cursor, v0, Gemini)
- **Team plans cluster at $25-40/seat/mo** across the board
- **No competitor offers BYOK** in their consumer product — this is a unique differentiator for Neore
- **Enterprise is universally custom** with SSO, SCIM, audit logs, and training data opt-out
- **Multi-model aggregators** (T3 Chat, TypingMind, Poe) are commoditizing model access — differentiation must come from tools, workflows, and integrations

**Key takeaway**: Pure multi-model chat access is being commoditized ($8/mo T3 Chat). Neore's moat is the *workspace* layer — tools, automation, creative generation, knowledge base, and team features. Price accordingly: don't compete on chat price, compete on workspace value.

---

## 6. Proposed Tier Structure

### Free Tier — "Try Everything"

**Price**: $0/mo
**Goal**: Conversion funnel entry. Let users experience the breadth.

| Feature | Limit |
|---|---|
| Text chat (free/budget models only) | 50 messages/day |
| Model selection | Llama 3.1 8B, Qwen3-8B, Gemma3-8B, GPT-OSS-20B |
| Search modes | Web, Code only |
| Image generation | 5 images/mo (Gemini Flash Image only) |
| Video generation | None |
| Documents/canvas | 3 documents |
| Code execution | 10 runs/mo |
| File uploads | 5 files/mo, 10MB max |
| Deep Research | None |
| Browser automation | None |
| Triggers/automation | None |
| Messenger bots | None |
| Memory | None |
| Knowledge base | None |
| BYOK | None |
| Support | Community |

**Why this works**: Users get a taste of multi-model access but hit limits quickly enough to convert. Free models cost us almost nothing.

---

### Starter Tier — "The ChatGPT Replacement"

**Price**: $16/mo (annual) / $20/mo (monthly)
**Goal**: Replace ChatGPT Plus. Core chat + light creative.

| Feature | Limit |
|---|---|
| Text chat (standard models) | 300 messages/day |
| Models | All non-premium (Claude Sonnet, GPT-4o, Gemini Pro, Grok, etc.) |
| Premium models (Opus, o1, o3) | 20 messages/day |
| Search modes | All 13 modes |
| Image generation | 50 images/mo (standard models) |
| Premium image models (FLUX Pro, Imagen, BFL Ultra) | 10 images/mo |
| Video generation | 5 videos/mo (standard models only) |
| Documents/canvas | Unlimited |
| Presentations | 10/mo |
| Design canvas | 10 designs/mo |
| Code execution | 50 runs/day |
| File uploads | Unlimited, 50MB max |
| Deep Research | 10 sessions/mo |
| Browser automation | None |
| Triggers/automation | None |
| Messenger bots | None |
| Memory | Enabled |
| Knowledge base | 1 knowledge base, 50 docs |
| BYOK | None |
| Chat import | Yes |
| Support | Email |

**Value proposition**: "Everything ChatGPT Plus gives you, plus Claude, Gemini, FLUX, and more — same price."

**Expected COGS**: $4-8/mo → 60-80% margin

---

### Pro Tier — "The Creative Powerhouse"

**Price**: $30/mo (annual) / $39/mo (monthly)
**Goal**: Replace ChatGPT + Midjourney + basic Runway. Power users and creators.

| Feature | Limit |
|---|---|
| Text chat (all models) | 500 messages/day |
| Premium models | 50 messages/day |
| Search modes | All 13 modes |
| Image generation (all models) | 200 images/mo |
| Premium image models | 50 images/mo |
| Advanced image editing | Unlimited (img2img, upscale, inpaint, outpaint, ControlNet) |
| Video generation (all models) | 30 videos/mo |
| Documents/canvas | Unlimited |
| Presentations | Unlimited |
| Design canvas (all presets/styles) | Unlimited |
| Code execution | Unlimited |
| Shell execution + file ops | Enabled |
| File uploads | Unlimited, 100MB max |
| Deep Research | 30 sessions/mo |
| Browser automation | 20 sessions/mo |
| Triggers/automation | 5 triggers, 100 executions/mo |
| Messenger bots | 1 connection |
| Auto-continue (Deep Work) | Enabled (25 steps) |
| Memory | Enabled |
| Knowledge base | 3 knowledge bases, 200 docs |
| BYOK | Yes (extend limits with your own keys) |
| Chat import | Yes |
| MCP servers | 3 servers |
| Speech-to-text | 60 min/mo |
| Text-to-speech | 50K chars/mo |
| Support | Priority email |

**Value proposition**: "ChatGPT Pro + Midjourney Standard + Runway Starter = $70/mo elsewhere. Get it all for $30/mo."

**Expected COGS**: $10-18/mo → 40-67% margin

---

### Max Tier — "Unlimited AI Power"

**Price**: $60/mo (annual) / $79/mo (monthly)
**Goal**: Power users, freelancers, and small agencies. Replaces 4-6 subscriptions.

| Feature | Limit |
|---|---|
| Text chat | Unlimited |
| Premium models | 200 messages/day |
| All search modes | Unlimited |
| Image generation | 500 images/mo |
| Premium image models | 200 images/mo |
| Video generation | 100 videos/mo |
| All advanced image editing | Unlimited |
| Documents/presentations/designs | Unlimited |
| Code execution + sandbox | Unlimited |
| Deep Research | Unlimited |
| Browser automation | 100 sessions/mo |
| Triggers/automation | 20 triggers, unlimited executions |
| Messenger bots | 5 connections |
| Auto-continue (Deep Work) | Enabled |
| Memory | Enabled |
| Knowledge bases | 10 bases, 1,000 docs |
| BYOK | Yes |
| MCP servers | Unlimited |
| Speech/audio | 300 min STT, 200K chars TTS |
| API access | Coming soon |
| Support | Priority + chat |

**Value proposition**: "Every AI tool. One price. No limits that matter."

**Expected COGS**: $20-35/mo → 42-56% margin

---

### Team Tier — "AI for Your Team"

**Price**: $40/user/mo (annual) / $49/user/mo (monthly)
**Minimum**: 3 users
**Goal**: Replace team subscriptions across ChatGPT Team + Midjourney + other tools.

| Feature | Limit |
|---|---|
| Everything in Max | Per user |
| Organizations | Roles & permissions |
| Shared threads | Unlimited |
| SSO/SAML | Included |
| Admin dashboard | Included |
| Centralized BYOK | Org-level API keys |
| Usage analytics | Per-user breakdown |
| Knowledge bases | 25 bases, 5,000 docs (shared) |
| Triggers | 50 triggers, unlimited executions |
| Messenger bots | 10 connections (shared) |
| Support | Priority + dedicated onboarding |

---

### Enterprise — "Custom Everything"

**Price**: Custom (starting ~$25/user/mo at volume)
**Goal**: Large organizations with compliance needs.

- Volume discounts
- Custom model routing
- Data residency options
- SSO/SCIM
- Dedicated support
- SLAs
- Audit logs
- Custom integrations
- On-prem option (future)

---

## 7. Feature Gating Strategy

### What gates conversion (Free → Starter)

1. **Model access** — Free only gets budget models. Wanting Claude Sonnet or GPT-4o forces upgrade.
2. **Message limits** — 50/day is enough to try, not enough to rely on.
3. **Image generation** — 5/mo on one model creates desire for more.
4. **No search modes** — Only web + code. Academic, finance, etc. require Starter.

### What gates upsell (Starter → Pro)

1. **Video generation** — 5/mo is a taste. Creators need 30+.
2. **Premium model limits** — 20/day vs 50/day for Opus, o3.
3. **Browser automation** — Not available on Starter.
4. **Triggers/workflows** — Not available on Starter.
5. **BYOK** — Power users want to extend limits with their own keys.
6. **Deep Research** — 10/mo vs 30/mo.
7. **Auto-continue** — Deep Work mode only on Pro+.

### What gates Max

1. **Volume** — Heavy users hit Pro limits (200 images, 30 videos).
2. **Messenger bots** — 1 vs 5 connections.
3. **Knowledge base scale** — 200 vs 1,000 docs.
4. **API access** — Coming soon on Max only.

---

## 8. BYOK Strategy

BYOK (Bring Your Own Key) is a powerful lever:

| Approach | Pros | Cons |
|---|---|---|
| **BYOK as Pro+ feature** | Upsell driver; power users who bring keys are low-COGS | Excludes some cost-sensitive users |
| **BYOK on all tiers** | Broader appeal; some users will prefer BYOK over paying more | Reduces upgrade incentive |
| **BYOK as separate mode** | Clear mental model | Complex UX |

**Recommendation**: BYOK on Pro+ tiers. When users bring their own keys, the platform rate limits are removed for that provider. This makes Pro+BYOK extremely attractive for heavy users while keeping Starter simple.

---

## 9. Revenue Projections

### Assumptions
- 10,000 registered users in first 6 months
- Conversion rates: Free→Starter 8%, Starter→Pro 25%, Pro→Max 15%

| Tier | Users | Price (annual) | MRR | COGS/user | Gross Margin |
|---|---|---|---|---|---|
| Free | 8,400 | $0 | $0 | $0.50 | -$4,200 |
| Starter | 800 | $16 | $12,800 | $6 | $8,000 (63%) |
| Pro | 500 | $30 | $15,000 | $14 | $8,000 (53%) |
| Max | 200 | $60 | $12,000 | $28 | $6,400 (53%) |
| Team | 100 users | $40 | $4,000 | $20 | $2,000 (50%) |
| **Total** | | | **$43,800** | | **$20,200 (46%)** |

### Key Metrics Target
- **Blended ARPU**: ~$27/paying user
- **Blended gross margin**: 46-55%
- **Free user cost**: ~$0.50/mo (budget models + infra only)
- **Break-even**: ~600 paying users at blended ARPU

---

## 10. Pricing Psychology

### Anchoring
Show Max ($79/mo) first on the pricing page. Pro ($39/mo) looks like a deal by comparison.

### Decoy Effect
Starter at $20/mo with limited creative features makes Pro at $39/mo feel like the obvious choice for anyone who wants images/video. The $19/mo jump gets you 4x the images, 6x the videos, plus automation.

### Annual Discount
20-24% discount on annual plans:
- Starter: $20 → $16/mo (save $48/yr)
- Pro: $39 → $30/mo (save $108/yr)
- Max: $79 → $60/mo (save $228/yr)
- Team: $49 → $40/user/mo

### Charm Pricing
Use round numbers for the premium feel. $20, $30, $60 on annual. Not $19.99.

---

## 11. What's Missing (Product Gaps to Fill)

### For "Coding" pillar to compete with Cursor
- [ ] Full IDE integration or web-based code editor
- [ ] Git integration (clone, commit, push from within Neore)
- [ ] Multi-file project support in sandbox
- [ ] Inline code suggestions / autocomplete
- [ ] Diff viewer for code changes

### For "Workflow" pillar to compete with Zapier/n8n
- [x] Skills system with slash commands and versioning (exists)
- [x] Community gallery with forking (exists)
- [x] MCP connectors for external tools (exists)
- [ ] Visual workflow builder (node-based UI) — schema exists, UI needed
- [ ] More trigger types (email, calendar, RSS)
- [ ] Conditional logic in workflows
- [ ] Workflow templates marketplace (gallery exists, needs curation)
- [ ] Webhook response customization

### For "Agent Builder" as a distinct product
- [x] Skills system as proto-agent builder (exists)
- [x] Playground API for programmatic access (exists)
- [ ] Custom agent creation UI (no code) — extend skills UI
- [ ] Agent marketplace / sharing — extend community gallery
- [ ] Custom tool definitions (user-created tools)
- [ ] Agent-to-agent communication
- [ ] Agent monitoring dashboard
- [ ] API for running agents programmatically — extend playground API

### For "Teams/Enterprise"
- [ ] Usage dashboards per team member
- [ ] Cost controls and budgets per user
- [ ] Content moderation / compliance controls
- [ ] Audit logs
- [ ] SCIM provisioning

---

## 12. Go-to-Market Recommendations

### Phase 1: Launch (Month 1-3)
1. Ship Free + Starter + Pro tiers
2. Position against ChatGPT Plus: "Same price. 30x the models."
3. Focus on individual creator persona
4. BYOK on Pro to attract cost-conscious power users

### Phase 2: Expand (Month 3-6)
1. Launch Max tier once usage patterns are clear
2. Add Team tier with org features
3. Build agent builder MVP (no-code custom agents)
4. Launch API access on Max tier

### Phase 3: Enterprise (Month 6-12)
1. Enterprise tier with sales-led motion
2. Compliance features (SOC2, audit logs)
3. Agent marketplace
4. Visual workflow builder
5. IDE integrations for coding pillar

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Heavy users abuse flat-rate pricing** | Negative margins | Usage caps on expensive features (video, premium models) + fair use policy |
| **API cost increases from providers** | Margin erosion | BYOK option shifts cost to user; diversify providers; negotiate volume deals |
| **OpenRouter dependency** | Single point of failure | Already have direct provider integrations (FAL, BFL, Kling, Luma, Replicate) as backup |
| **Competitor price war** | Downward pressure | Differentiate on breadth (no one else has 30+ models in one workspace) |
| **Free tier costs too much** | Cash burn | Only free/budget models; strict daily limits; no expensive features |
| **Feature creep across pillars** | Diluted positioning | Focus marketing on chat+creative. Coding and workflow are bonus value, not primary pitch. |

---

## 14. Recommended Immediate Actions

1. **Implement usage tracking** — Before changing pricing, ensure per-user COGS visibility (token usage, image/video counts, API costs per user)
2. **Add tier gating infrastructure** — Feature flags for tier-based access (some already exist via `isPremium` and `featureFlag`)
3. **Ship usage dashboards** — Users need to see their consumption to understand the value
4. **A/B test pricing page** — Start with Starter ($20) + Pro ($39) and measure conversion
5. **Build fair-use policy** — Define what "unlimited" means to protect against abuse on Max tier

---

## 15. Summary: Recommended Tier Matrix

| | Free | Starter $16-20/mo | Pro $30-39/mo | Max $60-79/mo | Team $40-49/user/mo |
|---|---|---|---|---|---|
| **Text models** | Budget only | Standard | All | All | All |
| **Premium models** | No | 20/day | 50/day | 200/day | 200/day |
| **Reasoning models** | No | Basic (low effort) | Full (all effort levels) | Full | Full |
| **Search modes** | 2 | All | All | All | All |
| **Images/mo** | 5 | 50 | 200 | 500 | 500 |
| **Videos/mo** | 0 | 5 | 30 | 100 | 100 |
| **Deep Research** | 0 | 10/mo | 30/mo | Unlimited | Unlimited |
| **Browser** | No | No | 20/mo | 100/mo | 100/mo |
| **Triggers** | No | No | 5 | 20 | 50 |
| **Messenger** | No | No | 1 | 5 | 10 |
| **Deep Work** | No | No | Yes | Yes | Yes |
| **Skills** | View only | Create + 5 active | Unlimited | Unlimited | Unlimited + shared |
| **MCP connectors** | No | 1 built-in | 3 built-in + custom | Unlimited | Unlimited |
| **BYOK** | No | No | Yes | Yes | Yes (org-level) |
| **Knowledge base** | No | 50 docs | 200 docs | 1K docs | 5K docs |
| **Vault storage** | 500 MB | 5 GB | 20 GB | 100 GB | 500 GB |
| **Audio** | No | No | Yes | Yes | Yes |
| **Playground API** | No | No | No | Yes | Yes |
| **Community gallery** | Browse | Browse + publish | Browse + publish | Browse + publish | Private gallery |
| **Teams/SSO** | No | No | No | No | Yes |

---

*This document should be reviewed alongside actual usage data once the tracking infrastructure is in place. All COGS estimates are approximations based on public API pricing as of March 2026.*
