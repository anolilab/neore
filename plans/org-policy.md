# Organization policy: locks and caps set by an organization's owner

**Status:** proposal, 2026-11-02. Nothing is built. Two decisions in "Open decisions" need the owner.

## 1. The problem

An organization can store settings for its members (allowed models, billing email), but nothing
enforces them where it matters:

- The organization's `allowedModels` list is saved, and the billing and settings screens show it. A run
  does not read it: the model filter at run time (`loadModelFilterRules`) reads only the user's own
  rules. `isModelAllowed` has no callers. So a member's chat can use a model the organization disallowed.
- A member can change any setting in their own preferences, including the ones an organization would
  want fixed (the default permission mode, tool permissions, provider keys).
- There is no way for an owner to lock a setting or cap what members' threads, agents or scheduled
  tasks may do.

## 2. What this adds

An owner writes one **policy document** per organization. Members' apps show what is locked and why, and
the backend refuses any write or run that would break a lock or exceed a cap.

The policy is versioned (`schemaVersion`) and deliberately small. It covers:

- **Model lock:** the organization's allowed models, enforced at run time for every member's run,
  including scheduled tasks, triggers and sub-agents.
- **Setting locks:** a named setting per key (for example the default tool permission mode), either a
  default members may change or a value they may not change.
- **Permission cap:** the broadest tool permission (`off`, `ask`, `auto`) any run may use. Above the cap
  the run is refused, not silently lowered.

Out of scope for now: provider launch fields, client-surface restrictions, pairing, webhook triggers,
telemetry switches and update channels. Each needs its own slice once the first four are in place.

## 3. Storage

A new `.global()` table, `organizationPolicies`, keyed by organization. It is not a column on
`organization`, which is a hand-kept copy of the auth provider's table and is checked against it.

- Owned by the `auth` module (it is organization billing and settings).
- Added to the audit trigger list.
- Not personal data, so no erasure step beyond the organization's own deletion. Decide whether an
  organization's deletion removes its policy row (it should).
- Authorization rows for each new procedure in `docs/security/authz-matrix.md`.

## 4. Validation

The document is parsed from the raw JSON, not through a validator that strips unknown keys. A write is
refused if it has an unknown key, an unknown `schemaVersion`, a wrong type, or a lock on a key that is
not managed. Invalid policies are never stored, so the enforcement code can assume a valid document.

## 5. Who writes, who reads

- **Write:** organization owners only, the same rule as the billing settings. Admins may read.
- **Read:** one query returns the policy and its version for the caller's organization. Every app reads
  it through that query. The desktop, web and extension subscribe to it live; mobile keeps the last value
  in its read-only cache and labels it as possibly stale.

## 6. Enforcement (backend, at the trust boundary)

- **Settings:** the single write path for preferences (`auth/lib/preference-writes.ts`) refuses a write to
  a locked key. The effective value for a read is the locked value, or the user's own value otherwise.
- **Models:** the organization's allowed models are merged into the run's model filter with the existing
  `mergeModelFilterRules` (allow lists intersect). This also fixes the gap in section 1.
- **Permission cap:** applied inside `resolveToolPermission`, before time-boxed grants, low-risk
  auto-approval and headless inheritance. A grant or auto-approval cannot exceed the cap.
- **Known gap:** device "Always allow" rules are stored and checked on the user's own computer. The backend
  can refuse to offer them under a cap, but it cannot revoke a rule already stored there. Say so in the
  admin view.

## 7. Client display

Locked controls show "Managed by <organization>" and cannot be changed. Web first, then desktop, mobile
and the extension. Nothing is added to the first-paint queries (`first-paint.e2e.test.ts` enforces the
budget): the policy is folded into an existing composite or loaded after first paint.

## 8. Slices

1. Table, validator, owner-only write, member read. No enforcement yet.
2. Settings locks and the model lock, enforced in the backend. Includes the run-time model fix.
3. The permission cap.
4. "Managed by" display on web, then desktop, mobile and the extension.

Each slice is one PR with its own tests.

## 9. Open decisions

1. **Which organization applies. Decided: the selected organization's policy.** Each organization is its own
   space. The policy loads from the selected organization on every switch, and runs use the policy of the
   space they run in. A space whose organization has no policy uses the user's own settings and rules, and
   nothing in it is hidden. Known escape: switching to a space with no policy (another organization, or the
   personal space) lifts the locks in that space. Accepted as a risk; the admin view says so. The strictest
   policy across all organizations was the alternative and is not chosen.
2. **Behaviour when a policy cannot be read.** Default proposed: a write to a locked key fails closed (the
   write is refused); a default that cannot be read keeps the user's own value. Confirm before slice 2.
