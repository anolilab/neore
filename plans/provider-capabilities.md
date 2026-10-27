# Provider capabilities

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Read by the ACP host ([acp-agent-host.md](acp-agent-host.md)), the orchestrator
([agent-orchestrator.md](agent-orchestrator.md)) and the mobile client
([mobile-acp-and-remote-control.md](mobile-acp-and-remote-control.md)).

## 1. Goal and decision

Every runner (the cloud agent loop, a headless sub-agent run, an ACP agent on a
host) reports what it can do as typed values. Every feature that depends on a
capability states what happens when it is missing. UI code reads the typed
values and never checks a provider's or agent's name.

**Decision.** One closed type, `Capability`, with three degradation values
(`restart`, `synthetic`, `divergent`). A capability that is absent or `unknown`
counts as unsupported, so its control is hidden. Cloud runners declare their
capabilities statically in code. Host runners report theirs at session start,
and the backend stores the report on the host session row. Report only what the
runner actually enforces: a control the runner ignores is worse than a hidden
one.

## 2. Current state (checked)

- `packages/ai/src/models/registry.ts` describes models (catalog, modalities,
  reference-image caps). It says nothing about what a runner does with a model,
  and it stays that way.
- Cloud interactive runs already steer: `backend/lunora/chat/steering.ts`
  (`steerRun`, `deliverSteers`) queues a message into a running stream at a step
  boundary, recorded on `persistentStreams.steers`.
- Headless runs (`runHeadlessAgent`, used by `backend/lunora/sub-agents/execute.ts`)
  create no persistent stream, so nothing can be steered into them. A follow-up
  waits for the run to end.
- Each UI that needs a per-runner answer today derives it locally. There is no
  shared table.
- `packages/ai` exports by subpath (`./models`, `./providers`, `./tools`, ...).
  Neither `apps/mobile` nor `apps/desktop` depends on it today.

## 3. The type

```ts
type Capability =
  | { supported: true; degradation: "none" }
  | { supported: true; degradation: "restart" | "synthetic" | "divergent"; note: string }
  | { supported: false; reason: "not_offered" | "not_enforced" | "unknown" };
```

| Degradation | Meaning | Example | UI rule |
| --- | --- | --- | --- |
| `none` | works natively | cancel on an ACP agent that advertises it | normal control |
| `restart` | works by ending the current run and starting another | steer on a runner that can only interrupt | control labelled "interrupt and restart" |
| `synthetic` | Neore emulates it | fork rebuilt from the saved transcript | control shown, with a note |
| `divergent` | works, but the runner's own memory no longer matches what the user sees | file rollback that leaves the agent's context as it was | control shown with a warning, confirm before use |

`not_offered`: the runner does not have it. `not_enforced`: the runner accepts
the setting but does not enforce it (a mode the agent lists but ignores). Both
hide the control. `unknown`: the runner did not say; treated as unsupported.

A degradation value is added only by owner decision. The set stays closed so the
UI can handle every case.

## 4. Capability groups

| Group | Members | Read by |
| --- | --- | --- |
| `sessions` | `create`, `load`, `listNative` | ACP S6 (native import) |
| `turns` | `cancel`, `followUp` (`queue` \| `steer` \| none) | orchestrator S3, ACP S1, chat composer |
| `streaming` | `text`, `reasoning`, `toolParts` | chat rendering |
| `tools` | `call`, `approvalRequest`, `declinePath` | ACP S2 |
| `permissions` | `modes`: the modes the runner enforces itself | mode menu |
| `planning` | `planMode` | chat |
| `subagents` | `ownChildren` (the runner spawns its own children) | orchestrator lineage view |
| `context` | `compactOnRequest`, `usageMeter` | context bar |
| `checkpoints` | `fileRollback`, `memoryRollback` | rollback UI |
| `identity` | `models`, `account`, `reasoningEffort` | model picker |

`turns.followUp` is not a `Capability` but a value: `{ kind: "steer" }`,
`{ kind: "queue" }` or `{ kind: "none" }`, with `restart` expressed as
`{ kind: "steer", degradation: "restart" }`. Every other member is a
`Capability`. `permissions.modes` and `identity.models` are lists; an empty list
means "not offered".

A full report is `CapabilityReport = { version: 1; reportedAt: number; groups: ... }`.
`version` lets a stored report be read after the type grows; a missing member in
a stored report reads as `unknown`.

## 5. Where the values come from

| Runner | Source | Stored |
| --- | --- | --- |
| Cloud interactive (`runStreamingAgent`) | static declaration in code: cancel, steer, text, reasoning, tool parts, tool approval, synthetic fork | no; computed |
| Cloud headless (sub-agent and worker runs) | static: cancel, follow-up `queue`, no steer | no; computed |
| Local browser model (`backend/lunora/chat/local-models.ts`) | static: text only, cancel, follow-up queue, no tools | no; computed |
| ACP agent on a host | mapped from what the agent advertises at `initialize` and session open (ACP S1 reads the spec for the names) | yes, on the ACP session row |

The mapping from ACP advertisement to `CapabilityReport` is one pure function in
the desktop main process. It never infers a capability from an agent or model
name. Anything it cannot map is `unknown`.

**Model lists.** For an ACP agent, the model picker reads the agent's model config
option when it advertises one. The legacy model state is used only when no such
option exists. Effort or thinking levels are separate config values, not part of
the model's id, so the picker shows one row per model and never one row per
model-and-effort pair. Variants that differ only in context window collapse into
the base row, and the window is shown as a trait. S2 of this plan writes the rule
as a pure function with a test per case, and the ACP host calls it.

## 6. Design

### Package

A new dependency-free subpath, `@neore/ai/capabilities`, in
`packages/ai/src/capabilities/`: the types, the static declarations of §5, the
validator, and the pure gating rules. It imports nothing else from
`packages/ai`. The web app, the desktop main process, the backend and the mobile
app import it. A test asserts the built subpath has no imports outside itself.
If the package's build cannot keep a subpath isolated, the same files move to a
new `packages/capabilities` instead; S1 decides.

### Backend storage

- A Lunora validator `vCapabilityReport` in the backend, mirroring the type, used
  by the ACP session table (`acpSessions.capabilities`,
  [acp-agent-host.md](acp-agent-host.md) §5.1). It is spelled out inline as a
  `v.object({...})`, not through a const reference, so codegen can type it.
- A report arrives on the ingest route with the session-open event and on every
  host reconnect. The backend validates it and replaces the stored copy
  wholesale. A report that fails validation is stored as "all unknown", and the
  failure is logged.
- `getThreadCapabilities` (authQuery, `.output()` declared): returns the stored
  report for a host-run thread, or the static declaration for a cloud thread.
  Owner or read-grant only, like any thread read. One authz-matrix row.

### Gating rules (pure, in the shared subpath)

- `isAvailable(cap)`: `supported === true`.
- `followUpControl(report)`: `"steer"`, `"steer-restart"`, `"queue"` or `"none"`.
- `visibleModes(report)`: the enforced modes only.
- Every UI control that depends on a capability calls one of these. A control
  never reads `report.groups` directly.

### No provider names in UI code

A test (`capabilities.no-provider-names.test.ts` in `apps/web`) greps
`apps/web/src/features/**` and `packages/chat-ui/src/**` for agent and provider
identifiers from a list kept beside the test, and fails on a match outside the
adapter files it allowlists. If the repo's ESLint config can express it as a
`no-restricted-syntax` rule instead, use that.

## 7. Slices

**S1 — Types, static declarations, rules, validator.** §3, §4, the three static
declarations of §5, the rules of §6, and the `vCapabilityReport` validator of
§6 (backend storage), so ACP S3 can add `acpSessions.capabilities` with it. No
callers.
- Acceptance: for every member of §4, a test asserts that a report without it
  reads as unsupported; `followUpControl` returns `"queue"` for the headless
  declaration and `"steer"` for the cloud interactive one; the subpath import
  test passes; `Infer<typeof vCapabilityReport>` is assignable to the type.

**S2 — Stored reports for host sessions.** The ingest's session-open and reconnect
events write the report to `acpSessions`, and `getThreadCapabilities` reads it.
Needs ACP S3.
- Acceptance: the stored report equals what the host sent; a reconnect with a
  changed report replaces it; an invalid report is stored as all unknown; a
  stranger's call to `getThreadCapabilities` returns nothing.

**S3 — Gated controls.** The steer control, the mode menu, the compaction button
and the rollback actions read the rules. The "no provider names" test lands.
- Acceptance: per control, a component test asserts it is absent when the
  capability is absent or `unknown`, and labelled "interrupt and restart" for a
  `restart` steer; the grep test fails on an injected provider name.

## 8. Invariants

- No provider-name conditionals in UI code (§6).
- A capability is never inferred from a model or agent name.
- `unknown` is unsupported, everywhere, including on mobile.
- `.output()` declared on `getThreadCapabilities`; its row in
  `docs/security/authz-matrix.md`.

## 9. Risks

- **Over-reporting.** A runner that claims a capability and fails at it is worse
  than one that claims nothing. Every `supported: true` in a static declaration
  has a test that exercises it.
- **Stale reports.** An agent upgrade changes what it can do. Refreshing on every
  reconnect covers the common case. A report also carries `reportedAt`, so the UI
  can show its age.
- **Drift between the TS type and the Lunora validator.** A type-level test
  asserts `Infer<typeof vCapabilityReport>` is assignable to `CapabilityReport`
  and back.

## 10. Open questions

1. **Package home.** Recommendation: the `@neore/ai/capabilities` subpath; fall
   back to a new package if S1's isolation test cannot pass.
2. **Stored per thread or per agent version.** Recommendation: per ACP session
   row (one per host-run thread), refreshed on reconnect. A per-version cache adds
   nothing until several threads share one agent build and the report is costly.
