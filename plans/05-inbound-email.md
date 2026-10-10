# Feature Plan: Inbound Email Integration (Mail Neore)

**Status:** Draft
**Priority:** Medium
**Estimated Complexity:** Medium
**Reference:** Claude CodeAI Mail Claude Code

---

## 1. Overview

Inbound email integration gives each user a unique email address (e.g., `username@mail.neore.chat`) that can receive emails and trigger AI tasks. Users can forward emails to this address to have the AI process, summarize, draft responses, or take actions based on the email content. This turns Neore Chat into a personal email assistant that works asynchronously without needing to open the app.

### Why This Matters

- Email remains the #1 communication channel for professionals
- Processing email is one of the biggest time sinks — average professional spends 28% of their workday on email
- Forwarding an email to trigger an AI task is extremely low-friction (no app switching needed)
- Workflow emails (purpose-specific addresses) enable fully automated email processing pipelines
- Combined with Connectors and Scheduled Tasks, this creates powerful email-driven automation

### How Claude CodeAI Does It

Claude CodeAI's Mail Claude Code feature:

- **Unique Bot Address:** Each user gets `username@manus.bot` (customizable, changeable once per 7 days)
- **Trigger Mechanism:** Forward/CC an email to trigger tasks; subject + body + attachments become task context
- **Security:** Only emails from pre-approved sender addresses can trigger tasks
- **Workflow Emails:** Create purpose-specific addresses (e.g., `travel@manus.bot`, `expenses@manus.bot`) with default prompts
- **Response:** Results sent back to user's inbox as email with file attachments
- **Gmail Integration:** One-click connection for reading threads, replying, and sending
- **Email Filters:** Users set up email client rules to auto-forward specific emails
- **Processing Time:** Simple summaries 1-2 min, comprehensive research 10-15 min

**Key Use Cases from Claude CodeAI:**
1. Email triage — Forward inbox, get categorized summary with draft responses
2. Travel management — Forward booking confirmations, get itinerary + calendar entries
3. Expense tracking — Forward receipts, get categorized expense report
4. Content processing — Forward newsletters, get key takeaways and slides

**Sources:**
- [Mail Claude Code | Turn Email into Action](https://docs.neore.chat/features/mail)
- [Mail Claude Code Documentation](https://docs.neore.chat/docs/features/mail-manus)
- [How can I use Mail Claude Code?](https://help.neore.chat/en/articles/12059745-how-can-i-use-mail-manus)

---

## 2. Current State in Neore Chat

### What We Already Have

- **Outbound Email:** Sending through `backend/lunora/email/mailer.ts` (Resend, or the Cloudflare send binding when configured), with React Email templates in `backend/lunora/email/templates/`
- **Email Templates:** Verification, password reset, organization invites, OTP, welcome, subscription
- **Email Event Handling:** Delivery tracking webhook in `backend/lunora/email/webhook.ts` (delivered, bounced, complained). It verifies Svix signatures, which is the pattern the inbound webhook should follow.
- **HTTP Router:** `backend/lunora/http.ts` for handling webhooks
- **Thread System:** Full thread management in `backend/lunora/chat/` and `backend/lunora/agent/`, usable as task context
- **AI Pipeline:** The agent loop in `backend/lunora/chat/execute.ts`, which already runs as a background job on the jobs queue
- **Background jobs:** `backend/lunora/lib/job-queue.ts` for work that must outlast one request

### What's Missing

- No inbound email receiving capability (no email handler exists in any Worker)
- No user-specific email addresses
- No email-to-task conversion pipeline
- No workflow email system (purpose-specific addresses with default prompts)
- No approved senders management
- No email result delivery template

---

## 3. Architecture Design

### 3.1 Email Receiving Options

| Service | How It Works | Cost | Pros | Cons |
|---------|-------------|------|------|------|
| **Resend Inbound** | Webhook on email receipt | Included in plan | Already using Resend | Limited inbound features |
| **SendGrid Inbound Parse** | Webhook on email receipt | Free tier available | Mature, reliable | Additional vendor |
| **Cloudflare Email Workers** | Workers handle inbound email | Free (with CF plan) | Already on Cloudflare | Requires DNS setup |
| **AWS SES** | S3 + Lambda on receipt | ~$0.10/1000 emails | Highly scalable | Complex setup |
| **Mailgun Routes** | Webhook on email receipt | Free tier available | Good API | Additional vendor |

**Recommended: Cloudflare Email Workers** — We're already deployed on Cloudflare, so Email Workers provide native integration without additional vendors. Alternatively, **Resend Inbound** if available since we already have Resend integrated.

### 3.2 High-Level Flow

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  User's Email │────▶│  Cloudflare      │────▶│  Lunora HTTP      │
│  Client       │     │  Email Worker    │     │  Action (webhook) │
│  (Forward)    │     │  (parse + relay) │     │                   │
└──────────────┘     └─────────────────┘     └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  Email Processor   │
                                              │  1. Validate sender│
                                              │  2. Parse content  │
                                              │  3. Match workflow │
                                              │  4. Create task    │
                                              └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  AI Pipeline       │
                                              │  (process email    │
                                              │   with prompt)     │
                                              └────────┬─────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  Result Delivery   │
                                              │  1. In-app thread  │
                                              │  2. Reply email    │
                                              │  3. Notifications  │
                                              └──────────────────┘
```

### 3.3 Data Model

> **Design principles:**
> - Each feature folder declares the tables it owns in its `module.ts` (see `backend/lunora/email/module.ts`); the tables themselves are defined in `backend/lunora/schema.ts`
> - `userId` is a string (Better Auth user IDs)
> - Separate processing stats from config (hot/cold data)
> - Use `+` addressing for workflows (`username+travel@mail.neore.chat`) — single MX record
> - New files: `backend/lunora/email/` (see 3.4)

Four tables:

**`mailConfig`** — per-user inbound email configuration. One row per user. Each user gets a unique address (`{address}@mail.neore.chat`) for forwarding emails to trigger AI processing. Only emails from approved senders are processed (security by default).
- `userId`, `address` (the "username" part of `username@mail.neore.chat`), `isActive`
- `approvedSenders`: email addresses allowed to trigger tasks
- `approveAllSenders`: if true, any sender is accepted (opt-in)
- `defaultPrompt` (optional): default processing instruction
- `lastAddressChangeAt` (optional): rate limit of one change per 7 days
- `createdAt`
- Indexes: by user, by address
- Relations: many `mailWorkflows`; `inboundEmails` by `userId`; the user by `userId`

**`mailWorkflows`** — purpose-specific email addresses with default prompts. Each workflow creates a `+` address (e.g., `username+travel@mail.neore.chat`) with a pre-configured prompt, optional skill link, and delivery settings. Workflows enable fully automated email processing pipelines.
- `userId`, `name` ("Travel Assistant", "Expense Tracker"), `addressSuffix` ("travel" → `username+travel@mail.neore.chat`), `prompt`
- `skillId` (optional): reference to the skills table
- `connectorIds` (optional): references to user connectors
- `modelId` (optional): model override
- `delivery`: `replyToSender` (send result back as email reply), `postToThread` (post result to a thread), `threadId` (optional)
- `isActive`, `createdAt`, `updatedAt`
- Belongs to one `mailConfig` (via `mailConfigId`)
- Indexes: by user, by address suffix
- Relations: `inboundEmails` by `workflowId`

**`mailWorkflowStats`** — hot data separated from workflow config, so the workflow row is not rewritten on every email processed.
- `workflowId` (one row per workflow), `processedCount`, `lastProcessedAt` (optional), `errorCount` (optional)
- Index: by workflow

**`inboundEmails`** — log of received and processed emails. Each row is an email received at a user's `mail.neore.chat` address. Tracks processing status from receipt through AI execution to result delivery.
- `userId`, `fromAddress`, `toAddress`, `subject`
- `bodyText` (optional, truncated to 50K chars), `bodyHtml` (optional, truncated to 50K chars)
- Attachments: storage keys in the user's private storage (`storage:<key>` refs, see `backend/lunora/lib/storage-ref.ts`), plus `attachmentNames`
- `status`: `received`, `processing`, `completed`, `failed`, `rejected` (sender not approved)
- `threadId` (optional): execution thread
- `workflowId` (optional): matched workflow
- `resultSummary`, `errorMessage` (optional)
- `receivedAt`, `processedAt` (optional)
- Indexes: by user, by user and status, by workflow, by user and received time
- Relations: `mailWorkflows` (optional, via `workflowId`), `threads` (optional, via `threadId`), the user by `userId`

### 3.4 Backend Architecture

The folder `backend/lunora/email/` already holds outbound mail. The new files below go there. A separate `mail/` folder with its own `module.ts` is the alternative if the inbound tables should not share the outbound module.

```
backend/lunora/email/
├── inbound-config.ts       # Mail config CRUD (address, approved senders) (new)
├── inbound-workflows.ts    # Workflow email CRUD (new)
├── inbound-processor.ts    # Inbound email processing pipeline (new)
├── inbound-http.ts         # Webhook endpoint for receiving emails (new)
├── inbound-delivery.ts     # Send results back via email (new)
└── inbound-validators.ts   # Validation helpers (new)
```

**Key Components:**

1. **Webhook Receiver (`inbound-http.ts`, mounted in `backend/lunora/http.ts`):**
   - HTTP action receiving parsed email data from the Cloudflare Email Worker
   - Extracts: sender, recipient, subject, body (text + HTML), attachments
   - Validates the request signature with the helpers in `backend/lunora/lib/crypto.ts`, following `email/webhook.ts`
   - Routes to processor

2. **Email Processor (`inbound-processor.ts`):**
   - Validates sender against approved senders list
   - Determines target workflow from the recipient address
   - Stores attachments in the user's private storage through the vault (`backend/lunora/vault/`)
   - Constructs the AI prompt: `workflow.prompt + "\n\n---\n\nEmail:\nFrom: {from}\nSubject: {subject}\n\n{body}"`
   - Creates a thread and runs the agent as a job on the jobs queue
   - Triggers result delivery upon completion

3. **Result Delivery (`inbound-delivery.ts`):**
   - Formats the AI result into an email (React Email template)
   - Sends reply to the original sender (if configured)
   - Posts result to the designated thread (if configured)
   - Creates in-app notification through `notify()` (`backend/lunora/notifications/`)

### 3.5 Email Address Scheme

Uses standard `+` (plus) addressing — supported by all email clients, single MX record:

```
# Default personal address
{username}@mail.neore.chat

# Workflow-specific addresses (via + addressing)
{username}+{workflow}@mail.neore.chat

# Examples:
john@mail.neore.chat              → Default processing
john+travel@mail.neore.chat       → Travel workflow
john+expenses@mail.neore.chat     → Expense tracking workflow
john+news@mail.neore.chat         → Newsletter digest workflow
```

**Parsing logic:** Split the local part on `+`. Left = username (lookup in `mailConfig`), right = workflow suffix (lookup in `mailWorkflows.addressSuffix`). If no `+`, use the default prompt from `mailConfig`.

### 3.6 Frontend Architecture

```
apps/web/src/features/settings/mail/
├── mail-settings-page.tsx          # Main mail settings page
├── mail-address-config.tsx         # Personal address configuration
├── approved-senders.tsx            # Manage approved sender list
├── mail-workflows/
│   ├── workflow-list.tsx           # List of workflow emails
│   ├── workflow-card.tsx           # Individual workflow card
│   ├── create-workflow-dialog.tsx  # Create new workflow
│   └── edit-workflow-dialog.tsx    # Edit existing workflow
├── inbound-email-log.tsx           # Log of received/processed emails
└── hooks/
    ├── use-mail-config.ts          # Mail configuration state
    ├── use-mail-workflows.ts       # Workflow CRUD
    └── use-inbound-emails.ts       # Email log
```

Data access goes through cRPC (`@/lib/lunora/crpc`), like every other backend query and mutation.

### 3.7 Setup Guide UI

When users first enable Mail Neore, show a setup wizard:

```
Step 1: Choose Your Address
  → [username]@mail.neore.chat
  → [Change username]

Step 2: Add Approved Senders
  → [your-email@gmail.com]     [Add]
  → Or: [✓] Accept emails from any sender

Step 3: Set Default Instructions
  → "Summarize the email, identify action items, and draft a response."
  → [Use default] [Customize]

Step 4: Set Up Forwarding (Optional)
  → Instructions for Gmail: Settings → Forwarding → Add address
  → Instructions for Outlook: Rules → Forward to...

Done! Forward any email to john@mail.neore.chat to get started.
```

---

## 4. Phase 1: MVP

### Scope

- [ ] Set up Cloudflare Email Workers (or Resend Inbound) for receiving emails
- [ ] DNS configuration for `mail.neore.chat` subdomain
- [ ] Database schema for mail config, workflows, and inbound emails
- [ ] Webhook endpoint for receiving parsed emails
- [ ] Email processor pipeline (validate sender → parse → create thread → run AI → deliver result)
- [ ] Mail settings page (personal address, approved senders, default prompt)
- [ ] Result delivery via email reply (new React Email template)
- [ ] Result posting to in-app thread
- [ ] Inbound email log (view received/processed emails)
- [ ] Basic attachment handling (PDF, images, text files)
- [ ] Plan-based limits (5 emails/day free, 50/day pro)
- [ ] Setup wizard for first-time configuration

---

## 5. Phase 2: Workflow Emails

- [ ] Workflow email CRUD (create purpose-specific addresses)
- [ ] Workflow-specific prompts and model configuration
- [ ] Skill integration (link a workflow to a specific skill)
- [ ] Connector integration (use connected services in email processing)
- [ ] Email forwarding rule generator (generate Gmail/Outlook rules)
- [ ] Batch processing summary (digest of all processed emails)
- [ ] Attachment OCR/extraction for scanned documents

---

## 6. Phase 3: Advanced Email Features

- [ ] Conversational email threads (multi-turn email exchanges with the AI)
- [ ] Personalized bulk outreach (process contact lists, generate personalized emails)
- [ ] Email analytics (processing time, topics, action items extracted)
- [ ] Smart categorization (auto-categorize emails by type/urgency)
- [ ] Calendar integration (extract dates/events and create calendar entries)
- [ ] CRM integration (log email interactions to CRM via connectors)
- [ ] Team email addresses (shared organizational inbound processing)
- [ ] Email signature detection and stripping

---

## 7. Security Considerations

### Sender Validation
- Only process emails from pre-approved senders (default: off, must opt-in to "accept all")
- Validate sender via SPF/DKIM/DMARC where possible
- Rate limit per sender address (prevent abuse from compromised accounts)

### Content Security
- Sanitize HTML email content (prevent XSS in stored HTML)
- Scan attachments for malware signatures (basic checks)
- Size limits on emails and attachments (25MB total)
- Strip tracking pixels and external image references

### Data Protection
- Email content stored temporarily for processing, then cleaned up
- Attachment files follow existing vault cleanup policies
- Users can delete individual emails from the log
- GDPR export includes inbound email data

### Abuse Prevention
- Daily email processing limits per plan tier
- Reject emails larger than size limit silently
- Block obvious spam (basic heuristics)
- Monitor for unusual patterns (sudden spike in forwarded emails)

---

## 8. Email Templates

### Inbound Processing Result Email

```
Subject: Re: {original_subject} — Processed by Neore Chat

Hi {username},

Your email has been processed. Here's the result:

---
{ai_result}
---

📎 Attachments: {attachment_count} files processed
⏱ Processing time: {duration}
🔗 View full thread: {thread_url}

---
Neore Chat • Mail Integration
Manage your settings: {settings_url}
Unsubscribe from email results: {unsubscribe_url}
```

---

## 9. Technical Dependencies

### Existing
| Dependency | Purpose | Status |
|-----------|---------|--------|
| Resend | Outbound email sending | Already integrated (`backend/lunora/email/mailer.ts`) |
| React Email | Email templates | Already integrated (`backend/lunora/email/templates/`) |
| Hono HTTP | Webhook endpoints | Already available (`backend/lunora/http.ts`) |
| Cloudflare R2 | Attachment storage | Already integrated (private storage) |

### New Dependencies Needed
| Dependency | Purpose | Cost |
|-----------|---------|------|
| Cloudflare Email Workers | Inbound email receiving | Free with CF plan |
| OR Resend Inbound (if available) | Inbound email parsing | TBD |
| `postal-mime` or `mailparser` | Email MIME parsing | Free (npm) |

---

## 10. Files to Create/Modify

### New Files
- `backend/lunora/email/inbound-config.ts` — Mail config CRUD
- `backend/lunora/email/inbound-workflows.ts` — Workflow CRUD
- `backend/lunora/email/inbound-processor.ts` — Email processing pipeline
- `backend/lunora/email/inbound-http.ts` — Webhook endpoint
- `backend/lunora/email/inbound-delivery.ts` — Result delivery
- `backend/lunora/email/inbound-validators.ts` — Validation
- `backend/lunora/email/templates/mail-result.tsx` — Result email template
- `apps/web/src/features/settings/mail/` — Full frontend directory

### Files to Modify
- `backend/lunora/schema.ts` — Add mail tables
- `backend/lunora/http.ts` — Add email webhook route
- `apps/web/src/features/settings/` — Add mail tab to settings

---

## 11. Design Decisions (Resolved)

### 1. Email domain
**Decision: `mail.neore.chat`**
- Professional, clearly communicates purpose
- Separate subdomain from the main app (`neore.chat`)
- Easy to set up DNS MX records on a subdomain

### 2. Email provider
**Decision: Cloudflare Email Routing → Cloudflare Worker → Lunora HTTP action.**
- Already deployed on Cloudflare — no additional vendor
- Cloudflare Email Routing is free with any CF plan
- Email Worker parses the email (MIME) and POSTs structured data to a Lunora HTTP action
- Outbound replies still sent via the existing mailer (`backend/lunora/email/mailer.ts`)

### 3. Address scheme
**Decision: Plus addressing — `username+workflow@mail.neore.chat`.**
- Standard email convention supported by all email clients
- Single MX record — no wildcard DNS needed
- Users understand `+` addressing from Gmail/Google
- Parsing is trivial: split on `+` to get username and workflow suffix

### 4. Attachment limits
**Decision: 25MB total per email, max 10 attachments.**
- Matches standard email size limits
- Attachments stored in the user's private storage and referenced as `storage:<key>` refs
- Auto-cleanup after 30 days (configurable per workflow)

### 5. Conversation threading
**Decision: One-shot for Phase 1. Conversational threading in Phase 3.**
- Phase 1: Each email is processed independently — AI reads email, executes prompt, sends result
- Phase 3: Track `In-Reply-To` / `Message-ID` headers for multi-turn email conversations
- One-shot is simpler and handles 90% of use cases (forwarded emails, receipts, newsletters)

### 6. Free tier
**Decision: 5 emails/day free, 50/day pro, 200/day team.**
- Rate limited through `backend/lunora/lib/rate-limiter.ts` (`RATE_LIMIT_CONFIGS`, `checkRateLimit`), with a new config key for inbound emails
- Rejected emails (over limit, unapproved sender) don't count toward the limit
- Limit resets daily at midnight UTC

### 7. Custom domains
**Decision: Phase 3 feature for Enterprise plan.**
- Requires DNS verification + MX record delegation
- Organizations can use `@ai.company.com` for branded email processing
- Significant complexity (certificate management, SPF/DKIM/DMARC setup)
- Not needed for MVP — `mail.neore.chat` is sufficient

---

## 12. Cross-Feature Integration

| Feature | Integration Point |
|---------|------------------|
| **Skills** | `mailWorkflows.skillId` — link a workflow to a specific skill for processing |
| **Connectors** | `mailWorkflows.connectorIds` — use connected services during email processing |
| **Scheduled Tasks** | Scheduled tasks can process batches of forwarded emails on a schedule |
| **Prompts** | Default workflow prompt can be loaded from user's prompt library |
| **Discover/Playbook** | Email workflow templates in the gallery (e.g., "Receipt Tracker", "Newsletter Digest") |

---

## Appendix A: Claude CodeAI Mail Claude Code — Detailed Documentation

> Source: [Mail Claude Code Documentation](https://docs.neore.chat/docs/features/mail-manus), [Mail Claude Code Feature Page](https://docs.neore.chat/features/mail), [Mail Claude Code Help Center](https://help.neore.chat/en/articles/12059745)

### Setup Process (Claude CodeAI)

1. Navigate to **Settings > Mail Claude Code**
2. Copy unique bot email address (e.g., `yourname@manus.bot`)
3. Optional: Customize address (can update once every 7 days)

### Core Workflow

1. **Forward emails** to bot address, or **CC it** in conversations
2. **Claude Code analyzes** email content, attachments, and appended instructions
3. **Results sent back** to inbox as email responses with attachments when applicable

### Workflow Emails (Purpose-Specific Addresses)

Navigate to **Settings > Mail Claude Code > Workflow Emails** to create:

| Example Address | Default Prompt |
|----------------|---------------|
| `travel@manus.bot` | "Build itinerary, add check-ins to Calendar, set reminders, buffer time for travels" |
| `expenses@manus.bot` | "Process receipt, categorize expense, update tracking spreadsheet" |
| `newsletter@manus.bot` | "Auto-generate slides from newsletter content" |

### Email Client Integration

Create **auto-forwarding rules** in Gmail/Outlook:
- Match emails by sender, subject, or keywords
- Auto-forward to workflow-specific address
- Result: Fully automated email processing pipeline

### Gmail Integration Features

- One-click Gmail connection (no coding)
- Reads email threads for context
- Replies to emails in inbox
- Sends directly from Gmail
- Learns communication patterns over time

### Collaboration Features

- Add friends as recipients or CC them
- They automatically join the task
- Works both in email and in the Claude Code app

### Key Use Cases

1. **Before meetings:** Forward invite → get briefing with attendees, agenda, prep notes
2. **Travel planning:** Collect flight/hotel emails into one itinerary
3. **Resume screening:** Forward candidate emails for automated analysis
4. **Meeting prep:** Forward invitations for background research
5. **Recurring emails:** Automate processing of receipts, confirmations, newsletters
6. **Batch review:** Check one summary report instead of 100 individual emails

### Security & Privacy

- Industry-standard encryption for Gmail connection
- Claude Code never stores email content (processes and discards)
- Only emails from approved senders processed
- Customizable bot email address
- Fully accessible on mobile devices

### Performance Benchmarks

- Simple summaries: 1-2 minutes
- Comprehensive research: 10-15 minutes
- Status updates sent via email during processing
