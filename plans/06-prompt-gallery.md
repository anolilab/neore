# Feature Plan: Pre-Built Prompt/Template Gallery (Playbook)

**Status:** Draft
**Priority:** Medium-High
**Estimated Complexity:** Small-Medium
**Reference:** Claude CodeAI Playbook

---

## 1. Overview

A pre-built prompt/template gallery (called "Playbook") is a curated collection of ready-to-use prompt templates that users can launch with one click from the homepage or a dedicated browse page. Unlike the user-created Prompt Library (which is personal), the Playbook contains professionally curated templates organized by category, each with a clear input interface and expected output format.

### Why This Matters

- New users often don't know what to do with an AI chat — a gallery solves the cold-start problem
- Pre-built templates dramatically lower the barrier to entry for non-technical users
- Templates showcase the platform's capabilities (tools, formatting, analysis)
- This is one of the simplest features to implement with high user value
- Templates can later evolve into full Skills (see Skills plan)
- SEO opportunity: each template can be a landing page

### How Claude CodeAI Does It

Claude CodeAI's Playbook (`manus.im/playbook`):

- **Curated Templates:** Professional quotation generator, resume builder, slide generator, stock analysis, trip planner, code generator, etc.
- **Categories:** Business & Sales, Research & Analysis, HR & Compensation, Creative & Content, Development & Tools, Productivity, Communication
- **One-Click Launch:** Click a template → fill minimal input → AI handles research, analysis, and formatting
- **Free Credits:** Templates can be used with free daily credits
- **Community Libraries:** Separate community platforms for user-contributed prompts (AI Prompt Library, PromptVault Pro)

**Claude CodeAI's Recommended Prompting Structure:**
`[Role] + [Agentic Task] + [Steps] + [Output format]`

**Sources:**
- [Playbook - Claude Code](https://docs.neore.chat/playbook)
- [Slide Generator](https://docs.neore.chat/playbook/slide-generator)
- [Resume Builder](https://docs.neore.chat/playbook/resume-builder)

---

## 2. Current State in Neore Chat

### What We Already Have

- **Prompt Library:** Users can create, store, and manage personal prompts with template variables (`{{variableName}}`) — `backend/lunora/prompts/` and `apps/web/src/features/prompts/`
- **Prompt Optimization:** AI-assisted prompt improvement (`packages/ai/src/prompts/optimizer/`)
- **Prompt Variables:** Template variables with validation and default values
- **Chat Interface:** Full chat with model selection and tool integration (`apps/web/src/features/chat/`)
- **Marketing Pages:** Landing page infrastructure (`apps/web/src/features/marketing/`)

### What's Missing

- No curated gallery of pre-built prompts
- No categorized browsing experience
- No one-click launch from homepage/gallery
- No "featured" or "trending" templates
- No input form generation from template parameters
- No template-specific output formatting guidance

---

## 3. Architecture Design

### 3.1 Template Definition

Each playbook template is a structured prompt definition:

```typescript
interface PlaybookTemplate {
  // Identity
  slug: string;              // URL-safe: "stock-analysis"
  name: string;              // "Stock Analysis Report"
  description: string;       // Short description for gallery card
  longDescription?: string;  // Detailed description for detail page

  // Classification
  category: PlaybookCategory;
  tags: string[];
  icon: string;              // Emoji or icon identifier

  // Display
  featured: boolean;
  sortOrder: number;
  exampleOutput?: string;    // Preview of what the output looks like

  // Prompt
  prompt: string;            // The full prompt template with {{variables}}
  systemPrompt?: string;     // Optional system prompt override

  // Parameters (input fields)
  parameters: PlaybookParameter[];

  // Configuration
  suggestedModel?: string;
  requiredTools?: string[];
  outputFormat?: "text" | "markdown" | "table" | "code" | "chart";
}

interface PlaybookParameter {
  name: string;              // Variable name (matches {{name}})
  label: string;             // Display label
  type: "text" | "textarea" | "select" | "number" | "url" | "file";
  placeholder?: string;
  required: boolean;
  defaultValue?: string;
  options?: string[];        // For select type
  helpText?: string;
}

type PlaybookCategory =
  | "research"
  | "productivity"
  | "finance"
  | "development"
  | "creative"
  | "business"
  | "communication"
  | "education";
```

### 3.2 Database Schema

> **Design principles:**
> - Tables are defined in `backend/lunora/schema.ts` and owned by a module (see `backend/lunora/prompts/module.ts`)
> - Separate usage stats (hot data) from template definition (cold data)
> - Templates can be either prompt-based (text template) or skill-based (linked to a skill)
> - Templates are curated by the Neore team; community submissions in Phase 2
> - New files go in `backend/lunora/prompts/` (no `discover/` folder exists yet)

Two tables:

**`discoverTemplates`** — curated prompt/skill templates for one-click launch. A gallery of professionally curated templates organized by category. Each template can be either a prompt template (text injection) or linked to a skill (structured automation). Templates solve the cold-start problem for new users and showcase platform capabilities.
- `slug` (URL-safe, e.g. "stock-analysis"), `name`, `description` (short, for the gallery card), `longDescription` (optional, for the detail page)
- Classification: `category` (e.g. "research", "finance", "productivity"), `tags`, `icon` (emoji or lucide-react icon name)
- Display: `featured`, `sortOrder`, `exampleOutput` (optional preview)
- `templateType`: `"prompt"` (pure text template, works with any thread mode) or `"skill"` (links to a skill for structured automation)
- For prompt templates: `prompt` (full template with `{{variables}}`), `systemPrompt` (optional)
- For skill templates: `skillId` (reference to the skills table)
- `parameters`: the input fields shown in the launch dialog. Each has `name` (matches `{{name}}`), `label`, `type` (`text`, `textarea`, `select`, `number`, `url`), `placeholder`, `required`, `defaultValue`, `options` (for select), `helpText`
- Configuration: `suggestedModel` (optional), `searchMode` (optional, maps to the search modes in the tool builder), `requiredConnectors` (optional connector slugs), `threadMode` (optional: `text`, `image`, `video`)
- Admin: `isActive`, `createdBy` ("neore-team" or a user ID for community), `createdAt`, `updatedAt`
- Indexes: by slug, by category, by featured and active, by active, by template type and active
- Search over `name` and `description`, filtered by category and active

**`discoverStats`** — hot data separated from the template definition, so the template row is not rewritten on every launch.
- `templateId` (one row per template), `launchCount`, `completionCount` (optional; user sent a follow-up message), `savedToLibraryCount` (optional; user copied to personal prompts/skills), `lastLaunchedAt` (optional)
- Indexes: by template, by launch count (for the "Popular" sort)

### 3.3 Backend Architecture

No `discover/` or `playbook/` folder exists. The new files go in `backend/lunora/prompts/`, next to the Prompt Library they sit beside:

```
backend/lunora/prompts/
├── discover.ts              # Query templates, track usage (new)
├── discover-seed.ts         # Seed database with initial templates (new)
└── discover-validators.ts   # Validation (new)
```

The seed function is run the way the connector catalogue is seeded (`backend/lunora/connectors/seed.ts`, run with `lunora run <file>:<fn>`).

This is intentionally simple — the Playbook is primarily a content/UI feature. The backend just stores template definitions and tracks usage.

### 3.4 Frontend Architecture

```
apps/web/src/features/prompts/   (new files; no playbook/ folder exists yet)
├── playbook-page.tsx             # Main gallery page (browse all templates)
├── playbook-grid.tsx             # Grid of template cards with filtering
├── playbook-card.tsx             # Individual template card
├── playbook-detail-dialog.tsx    # Template detail with parameter form
├── playbook-category-filter.tsx  # Category tabs/sidebar
├── playbook-search.tsx           # Search input
├── playbook-launch-form.tsx      # Parameter form + launch button
└── hooks/
    ├── use-playbook-templates.ts # Fetch templates
    └── use-playbook-launch.ts    # Launch a template (create thread + send)
```

### 3.5 UI Design

**Gallery Page:**
```
┌─────────────────────────────────────────────────────────────┐
│  Playbook                                    [🔍 Search...] │
├─────────────────────────────────────────────────────────────┤
│  [All] [Research] [Productivity] [Finance] [Dev] [Creative] │
├─────────────────────────────────────────────────────────────┤
│  ⭐ Featured                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ 📊           │ │ 🔍           │ │ 📝           │        │
│  │ Stock        │ │ Deep         │ │ Meeting      │        │
│  │ Analysis     │ │ Research     │ │ Notes        │        │
│  │              │ │              │ │              │        │
│  │ Get company  │ │ Multi-source │ │ Generate     │        │
│  │ profiles,    │ │ research w/  │ │ structured   │        │
│  │ technicals.. │ │ citations... │ │ minutes...   │        │
│  │    [Launch]  │ │    [Launch]  │ │    [Launch]  │        │
│  └──────────────┘ └──────────────┘ └──────────────┘        │
│                                                             │
│  📊 Finance                                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │ 💱 Currency  │ │ 🪙 Crypto    │ │ 📈 Portfolio │        │
│  │ Converter    │ │ Report       │ │ Analysis     │        │
│  │    [Launch]  │ │    [Launch]  │ │    [Launch]  │        │
│  └──────────────┘ └──────────────┘ └──────────────┘        │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

**Launch Dialog:**
```
┌──────────────────────────────────────────────┐
│  📊 Stock Analysis Report                     │
│                                               │
│  Get comprehensive company profiles,          │
│  technical indicators, price charts,          │
│  and insider data.                            │
│                                               │
│  ┌──────────────────────────────────────┐     │
│  │ Stock Symbol *                       │     │
│  │ [AAPL                            ]   │     │
│  │ Enter a stock ticker symbol          │     │
│  └──────────────────────────────────────┘     │
│  ┌──────────────────────────────────────┐     │
│  │ Analysis Type                        │     │
│  │ [Full Analysis            ▼]         │     │
│  │ Options: Quick Overview, Technical,  │     │
│  │   Fundamental, Full Analysis         │     │
│  └──────────────────────────────────────┘     │
│  ┌──────────────────────────────────────┐     │
│  │ Additional Notes (optional)          │     │
│  │ [                                ]   │     │
│  └──────────────────────────────────────┘     │
│                                               │
│  Uses: Web Search, Finance tools              │
│  Model: Auto (Recommended)                    │
│                                               │
│               [Cancel] [▶ Launch]             │
└──────────────────────────────────────────────┘
```

### 3.6 Homepage Integration

Add a "Quick Start" section to the main chat page with featured templates:

```
┌─────────────────────────────────────────────────┐
│           What can I help you with?              │
│  ┌─────────────────────────────────────────┐    │
│  │ Ask anything...                         │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Quick Start                    [View all →]     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ 📊 Stock│ │ 🔍 Deep │ │ 📝 Email│           │
│  │ Analysis│ │ Research│ │ Drafter │           │
│  └─────────┘ └─────────┘ └─────────┘           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │ 💻 Code │ │ 📰 News │ │ 🗺️ Trip │           │
│  │ Review  │ │ Digest  │ │ Planner │           │
│  └─────────┘ └─────────┘ └─────────┘           │
└─────────────────────────────────────────────────┘
```

---

## 4. Pre-Built Templates (Initial Set)

### Research (5 templates)

1. **Deep Research Report**
   - Params: `topic` (text), `depth` (select: quick/thorough/comprehensive)
   - Tools: Web Search
   - Prompt: Multi-source research with citations, structured sections, and bibliography

2. **Academic Paper Analysis**
   - Params: `paper_url` (url) OR `paper_content` (textarea)
   - Tools: Web Search, Academic Search
   - Prompt: Summarize methodology, findings, critique, and relevance

3. **Competitor Analysis**
   - Params: `company` (text), `competitors` (textarea), `industry` (text)
   - Tools: Web Search
   - Prompt: SWOT analysis, market positioning, competitive advantages

4. **Reddit/Forum Sentiment Analysis**
   - Params: `topic` (text), `subreddits` (text, optional)
   - Tools: Reddit Search, Web Search
   - Prompt: Analyze community sentiment, key themes, and emerging trends

5. **News Digest**
   - Params: `topic` (text), `timeframe` (select: 24h/week/month)
   - Tools: Web Search
   - Prompt: Curated news summary with market impact analysis

### Finance (4 templates)

6. **Stock Analysis Report**
   - Params: `symbol` (text), `analysis_type` (select: quick/technical/fundamental/full)
   - Tools: Finance, Web Search
   - Prompt: Company profile, technical indicators, price charts, analyst ratings

7. **Crypto Market Report**
   - Params: `coins` (text, optional), `timeframe` (select: 24h/week)
   - Tools: Finance, Web Search
   - Prompt: Market-moving news, protocol updates, regulatory developments

8. **Currency Conversion & Trends**
   - Params: `from_currency` (text), `to_currency` (text), `amount` (number)
   - Tools: Finance
   - Prompt: Current rate, historical trends, and forecasting context

9. **Personal Budget Analyzer**
   - Params: `expenses` (textarea)
   - Tools: Visualization
   - Prompt: Categorize expenses, create charts, suggest savings

### Productivity (4 templates)

10. **Meeting Notes Generator**
    - Params: `raw_notes` (textarea), `meeting_type` (select: standup/planning/review/general)
    - Prompt: Structure notes into summary, decisions, action items, attendees

11. **Email Drafter**
    - Params: `context` (textarea), `tone` (select: formal/casual/friendly/persuasive), `recipient` (text)
    - Prompt: Draft professional email with appropriate tone and structure

12. **Document Summarizer**
    - Params: `content` (textarea) OR `file` (file)
    - Prompt: Key takeaways, main arguments, structured summary

13. **Project Brief Generator**
    - Params: `project_name` (text), `description` (textarea), `team_size` (number)
    - Prompt: Goals, milestones, deliverables, risks, timeline outline

### Development (4 templates)

14. **Code Review Assistant**
    - Params: `code` (textarea), `language` (select), `focus` (select: bugs/style/security/performance)
    - Tools: Code Execution
    - Prompt: Review for issues, suggest improvements, rate quality

15. **API Documentation Generator**
    - Params: `api_spec` (textarea), `format` (select: openapi/markdown/readme)
    - Prompt: Generate comprehensive API documentation from spec or code

16. **SQL Query Builder**
    - Params: `description` (textarea), `database` (select: postgres/mysql/sqlite)
    - Tools: Code Execution
    - Prompt: Convert natural language to SQL with explanation

17. **Regex Generator**
    - Params: `description` (textarea), `examples` (textarea)
    - Tools: Code Execution
    - Prompt: Generate regex with explanation and test cases

### Creative (3 templates)

18. **Blog Post Writer**
    - Params: `topic` (text), `tone` (select), `length` (select: short/medium/long), `keywords` (text)
    - Tools: Web Search
    - Prompt: SEO-optimized blog post with headings, intro, body, conclusion

19. **Social Media Content Pack**
    - Params: `topic` (text), `platforms` (multiselect: twitter/linkedin/instagram)
    - Prompt: Platform-specific content with hashtags and timing suggestions

20. **Presentation Outline**
    - Params: `topic` (text), `audience` (text), `duration` (select: 5min/15min/30min/60min)
    - Prompt: Slide-by-slide outline with key points and speaker notes

---

## 5. Phase 1: MVP

### Scope

- [ ] Database schema for playbook templates
- [ ] Seed function with 15-20 initial templates
- [ ] Playbook gallery page with category filtering and search
- [ ] Template card component
- [ ] Launch dialog with parameter form
- [ ] Launch action (create thread, inject prompt with filled parameters, redirect to chat)
- [ ] Homepage "Quick Start" section with 6 featured templates
- [ ] Usage tracking (increment count on launch)
- [ ] Navigation entry in sidebar
- [ ] Route: `/playbook` for gallery, `/playbook/:slug` for detail

---

## 6. Phase 2: Enhanced Gallery

- [ ] Template detail page with example output preview
- [ ] "Recently Used" section
- [ ] "Popular" section (sorted by usage count)
- [ ] User favorites (bookmark templates)
- [ ] Template sharing (generate share link)
- [ ] Category landing pages (SEO)
- [ ] User-submitted templates (community gallery)
- [ ] Template ratings and reviews
- [ ] Related templates suggestions

---

## 7. Phase 3: Advanced Features

- [ ] Template A/B testing (test different prompt versions)
- [ ] Personalized template recommendations based on usage patterns
- [ ] Template analytics dashboard (which templates are most used, completion rates)
- [ ] Template collections/bundles
- [ ] Premium templates (gated by plan)
- [ ] Integration with Skills system (upgrade template to skill)
- [ ] Multi-language templates (i18n support)
- [ ] Template versioning (track and revert changes)

---

## 8. Relationship to Other Features

### Discover Contains Both Prompts and Skills

The Discover gallery is the **unified entry point** for curated content. Each template has a `templateType`:

- **`templateType: "prompt"`** — Pure text templates. Works with any thread mode (text, image, video). Best for: image generation, personas, writing styles, simple prompts. On launch, creates a thread and injects the prompt text.

- **`templateType: "skill"`** — Links to a curated skill via `skillId`. Best for: multi-step workflows with tool config, search modes, scripts. On launch, activates the linked skill with the provided parameters.

This means Discover doesn't need to duplicate prompt or skill storage — it's a **curated gallery layer** that references existing prompts or skills.

### Discover → Personal Library

Users can save any Discover template to their personal library:
- Prompt templates → saved to the prompts table (`backend/lunora/prompts/`, existing)
- Skill templates → installed as a user skill (new; see `backend/lunora/skills/`)

The "Save to Library" button in the Discover UI handles both cases.

### Discover + Scheduled Tasks
Templates can be scheduled: "Run the Crypto Market Report template every day at 9am." The UI shows a "Schedule this" action that pre-fills the scheduled task form (`backend/lunora/tasks/`).

### Discover + Connectors
Templates can specify `requiredConnectors` — the launch dialog checks if the user has connected the required services and shows connect prompts if not.

### Discover + Inbound Email
Email workflow templates in the gallery (e.g., "Receipt Tracker", "Newsletter Digest") pre-configure a mail workflow when launched.

---

## 9. Files to Create/Modify

### New Files
- `backend/lunora/prompts/discover.ts` — Template queries and usage tracking
- `backend/lunora/prompts/discover-seed.ts` — Initial template data
- `backend/lunora/prompts/discover-validators.ts` — Validation
- `apps/web/src/features/prompts/` — Playbook frontend components (see 3.4)
- `apps/web/src/routes/` — Gallery route and template detail route (new route files)

### Files to Modify
- `backend/lunora/schema.ts` — Add playbook tables
- `apps/web/src/features/layout/` — Add sidebar navigation entry
- `apps/web/src/features/chat/` — Add "Quick Start" section to chat homepage

---

## 10. Design Decisions (Resolved)

### 1. Naming
**Decision: "Discover" — neutral, action-oriented, avoids Claude CodeAI's terminology.**
- URL: `/discover` for the gallery, `/discover/:slug` for individual templates
- Sidebar label: "Discover"
- Avoids "Playbook" (Claude CodeAI), "Templates" (too generic), "Gallery" (too vague)
- "Discover" communicates exploration and finding new capabilities

### 2. Free vs. premium
**Decision: All templates free. Templates drive engagement, not revenue.**
- Templates showcase platform capabilities — gating them reduces discovery and activation
- Revenue comes from usage (token limits, scheduled tasks, connectors), not template access
- Premium features attached to templates (e.g., required connectors) naturally gate advanced use cases

### 3. Community templates
**Decision: Phase 2. Curate everything ourselves for Phase 1 quality control.**
- Phase 1: 15-20 templates curated by Neore team, seeded by a seed function in `backend/lunora/prompts/` (new file, run like `backend/lunora/connectors/seed.ts`)
- Phase 2: Community submissions with moderation (submit → review → publish)
- Community templates carry a "Community" badge vs. "Official" badge

### 4. SEO
**Decision: Yes — each template gets a public landing page at `/discover/:slug`.**
- Excellent organic acquisition channel
- Each template page shows: name, description, example output, parameter form, CTA to sign up
- Server-rendered via TanStack Start for SEO

### 5. Analytics
**Decision: Track launches, completions, and saves. Stored in `discoverStats` (hot data).**
- `launchCount` — user clicked "Launch" and a thread was created
- `completionCount` — user sent a follow-up message (indicates engagement)
- `savedToLibraryCount` — user copied the template to their personal prompts or skills
- All tracked in the `discoverStats` table (separated from template definition)

### 6. Localization
**Decision: English only for Phase 1. i18n in Phase 3 when marketplace launches.**
- Templates contain natural language content — proper localization requires translation, not just string extraction
- Defer to Phase 3 alongside the marketplace (community can contribute translations)

---

## 11. Cross-Feature Integration

| Feature | Integration Point |
|---------|------------------|
| **Prompts** | Prompt-type templates saved to user's prompts. Discover is a curated layer, not a replacement. |
| **Skills** | Skill-type templates link to the skills table via `skillId`. "Save to Library" installs the skill. |
| **Connectors** | `requiredConnectors` — launch dialog shows connect prompts for missing connectors |
| **Scheduled Tasks** | "Schedule this" action pre-fills a scheduled task with the template's prompt/skill |
| **Inbound Email** | Email workflow templates pre-configure `mailWorkflows` on launch |
| **Browser Automation** | Templates can include browser-based tasks (via linked skill) |

---

## Appendix A: Complete Claude CodeAI Playbook Template List

> Source: [manus.im/playbook](https://docs.neore.chat/playbook) — All templates listed below are community-built and maintained by Claude CodeAI.

### Reports & Analysis (6 templates)

| Template | Description |
|----------|-------------|
| Report Generator | Transforms complex topics into polished reports. Outputs as slide deck, PDF, or interactive dashboard. |
| SWOT Analysis Generator | AI-powered SWOT analysis with professional reports and slides. |
| Market Research Tool | Comprehensive market research with insights. |
| Reddit Sentiment Analyzer | Analyzes Reddit sentiment, extracts insights, feedback, and reports. |
| Cost Analyzer | Analyzes costs and helps make smarter financial decisions. |
| Account Performance Analyzer | Monitors and improves account performance. |

### Business & Sales (11 templates)

| Template | Description |
|----------|-------------|
| CRM Dashboard Generator | Custom CRM dashboards to track sales, analyze data, drive growth. |
| Salary Review Tool | Data-driven salary reviews: benchmarks, compensation data, transparent reports. |
| Commission Calculator | Custom commission calculators with tiered structures and automated formulas. |
| Sales Quote Generator | Professional sales quotes in minutes. |
| Quotation Generator | Professional quotations. |
| Opportunity Pipeline Builder | Structured opportunity pipelines for improved forecast accuracy. |
| Discount Approval Workflows | Tiered discount approval workflows. |
| Incentive Program Manager | Designs, tracks, and manages incentive programs. |
| Employee Pulse Survey Generator | Targeted employee pulse surveys for real-time feedback. |
| Performance Review Generator | Fair and comprehensive performance reviews. |
| Salary Calculator | Total compensation calculator, hourly to annual, offer comparison. |

### Productivity & Operations (6 templates)

| Template | Description |
|----------|-------------|
| Shift Scheduler | Automates shift planning with optimized schedules. |
| Inventory Management | Smart inventory with AI-powered stock tracking and forecasting. |
| Receipt Tracker | Extracts vendor, date, total, and tax from receipt photos/emails. |
| Petty Cash Logs | Professional petty cash logs for business. |
| Onboarding Portals | Centralized onboarding portals for new hires. |
| Scheduling Assistant | Smart calendar management for teams. |

### Content Creation (8 templates)

| Template | Description |
|----------|-------------|
| AI Slides Generator | Transforms ideas into presentations. PPTX, Google Slides, or PDF output. |
| AI Story Generator | Creates complete, ready-to-publish narratives. |
| AI Video Generator | Transforms ideas into videos. |
| Writing Assistant | Business emails, blog posts, reports, social media, technical docs, creative stories. |
| Essay Outline Creator | Perfect essay outlines. |
| Introduction Email Generator | Professional introduction emails for any context. |
| PDF Summarizer | Transforms lengthy PDFs into clear, actionable summaries. |
| PDF Translator | Professional PDF translation preserving original formatting. |

### Design & Creative (5 templates)

| Template | Description |
|----------|-------------|
| AI Avatar Generator | Stunning AI avatars from photos or text descriptions. |
| AI Anime Generator | Transforms imagination into anime art. |
| Sketch-to-Image | Transforms sketches into vivid images. |
| Interior Design Preview | Upload photo, describe vision, preview realistic design. |
| Color Analysis | Finds right colors for skin tone, hair, and eyes. |

### Developer Tools (4 templates)

| Template | Description |
|----------|-------------|
| Code Generator | Python, JavaScript, React, TypeScript, Java, C++ and more. |
| GitHub Deployer | Deploys GitHub repos instantly or turns ideas into live projects. |
| Browser Tool Generator | Generates browser tools from requirements. |
| Startup POC | Validates startup concepts with proof-of-concept prototypes. |

### Personal Tools (9 templates)

| Template | Description |
|----------|-------------|
| Resume Generator | Professional resume for target position from basic info. |
| AI Trip Planner | Plans satisfying trips. |
| AI Math Solver | Step-by-step math solutions. |
| Workout Plan Generator | Custom workout plans. |
| Coupon Finder | Finds verified coupons and discount codes. |
| PC Builder | Custom PC building assistant. |
| Phone Comparator | Compares phones with detailed reports. |
| YouTube Influencer Finder | Discovers perfect YouTube creators for brands. |
| AI Profile Builder | Gathers and structures info on anything. |

**Total: 49 templates across 7 categories**

---

## Appendix B: Claude CodeAI Prompt Best Practices

> Source: [Claude Code Academy](https://academy.manus.im/), [Claude Code Documentation](https://docs.neore.chat/docs/)

### Recommended Prompt Structure

```
[Role] + [Agentic Task] + [Steps] + [Output format]
```

Example: "Act as an Excel spreadsheet expert. I need you to edit this spreadsheet [link]. I want you to [tasks] and export as a Google spreadsheet."

### Core Principles

1. **Be Specific and Focused** — "Describe how an ordinary librarian becomes the savior of her town" vs. "Write a story about a hero"
2. **Define Objectives, Boundaries, and Success Criteria** — Tightly scoped workflows
3. **Use Structure** — Numbered lists, bullet points, clear organization
4. **Break Down Complex Tasks** — Large tasks can hit context limits; split into separate tasks
5. **Use Delimiters** — Triple quotes, XML tags, section titles to separate instructions from context
6. **Provide Examples (carefully)** — Few-shot learning helps but can cause over-following in agent systems
7. **Encourage Step-by-Step Reasoning** — More accurate results on complex problems
8. **Supply Reference Materials** — Include guidelines and previous prompt collections
9. **Iterate and Experiment** — Revise based on generated outputs

### Advanced: Context Engineering (Claude Code Engineering Team)

- **KV-cache hit rate** is the single most important metric for production AI agents
- Avoid dynamically adding/removing tools mid-iteration unless necessary
- Introduce small **structured variation** in actions/observations to counteract repetitive patterns
- Factor prompts into 5 versioned blocks: System, Context, Step Policy, Output Contracts, Verification
