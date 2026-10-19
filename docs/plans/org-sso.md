# Per-organization SSO (SAML / OIDC) and SCIM — Plan

**Created:** 2026-10-19
**Status:** Planned. Not built: it is an authentication feature that cannot be
verified here without an identity provider, and half of it is a product decision.

## Where it stands

- One enterprise OIDC provider, switched on by `OIDC_*` env vars for the whole
  deployment (`auth.ts`, `auth/sign-in-methods.ts`). Every user and every
  organization shares it.
- No SAML, no SCIM, no way for an organization admin to register their own
  identity provider.
- Roles are the fixed `owner` / `admin` / `member` of `auth/permissions.ts`.
- Invite-only registration gates OAuth first sign-in on purpose
  (`sso-invite-gate.test.ts`).

## Design

1. **better-auth's SSO plugin** registers providers per organization (OIDC and
   SAML, matched by email domain). Check the installed better-auth version's
   plugin package and its schema before starting; add it to the pnpm catalog
   (mind `minimumReleaseAge` and `allowBuilds`).
2. **Schema:** the plugin's `ssoProvider` table is added to `schema.ts` by hand,
   `auth.schema.test.ts` is run (the D1 adapter throws on a mismatch), and the
   column must be optional or the build's drift gate fails.
3. **Invite-only:** an SSO sign-in for an unknown user must still pass the
   invitation gate, unless the organization's admin has verified the domain. That
   exception is the product decision: does a verified corporate domain count as
   an invitation?
4. **Admin surface:** register / verify-domain / disable for organization
   owners and admins only, each with a row in `docs/security/authz-matrix.md`
   and an `assertOwnOrganizationId` check (never an `organizationId` from args).
5. **SAML specifics:** signed assertions only, clock-skew window, the IdP's
   certificate stored and PINNED per provider (it is public, so it needs integrity, not secrecy), and the ACS URL on the
   backend origin (`PUBLIC_ORIGIN`), not the web origin.
6. **SCIM** (user lifecycle) is a separate step: deprovisioning must run the
   same erasure/offboarding path as a removed member, and tokens are per
   organization.

## Tests it needs before shipping

A SAML round trip against a test IdP, replayed-assertion and wrong-audience
rejection, the invitation gate with and without a verified domain, and a
cross-organization attempt to register or read another organization's provider.
