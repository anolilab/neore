/**
 * Who may see or change a skill.
 *
 * `skills` is a `.global()` table with no row-level security, so these checks are
 * the ONLY control between one user's private instructions and everyone else.
 * Every procedure that reads or writes a skill by id must go through them.
 *
 * `organizationId` is NOT a sharing signal on its own: `createSkill` stamps the
 * active organization onto every skill, private ones included. Only
 * `visibility: "organization"` opens a skill to the rest of that organization —
 * to read and, opt-in per member, to enable. Editing it stays with the owner and
 * the organization's admins.
 */

export type SkillVisibility = "organization" | "private" | "public";

export interface SkillAccessSubject {
    organizationId?: string | null;
    /** The subject's role in `organizationId` (`member`, `admin`, `owner`). */
    organizationRole?: string | null;
    userId: string;
}

export interface SkillAccessTarget {
    organizationId?: string | null;
    userId: string;
    visibility?: string | null;
}

/** Legacy rows have no `visibility`; they were created private. */
export const skillVisibility = (skill: Pick<SkillAccessTarget, "visibility">): SkillVisibility => {
    const { visibility } = skill;

    return visibility === "public" || visibility === "organization" ? visibility : "private";
};

const isSharedWithOrganization = (skill: SkillAccessTarget, subject: SkillAccessSubject): boolean =>
    skillVisibility(skill) === "organization" && !!subject.organizationId && skill.organizationId === subject.organizationId;

/** Owner, a member of the organization it is shared with, or anyone when public. */
export const canReadSkill = (skill: SkillAccessTarget, subject: SkillAccessSubject): boolean =>
    skill.userId === subject.userId || skillVisibility(skill) === "public" || isSharedWithOrganization(skill, subject);

/** Organization roles that may edit a skill someone else shared with the organization. */
const SKILL_EDITOR_ROLES: ReadonlySet<string> = new Set(["admin", "owner"]);

/** Whether a role grants editing; better-auth stores several roles as one comma-separated string. */
const isSkillEditorRole = (role: string | null | undefined): boolean => !!role && role.split(",").some((part) => SKILL_EDITOR_ROLES.has(part.trim()));

/**
 * Owner, or an admin/owner of the organization it is shared with. A plain member
 * may read and enable a shared skill but not rewrite what every member runs.
 * Public does not grant write.
 */
export const canWriteSkill = (skill: SkillAccessTarget, subject: SkillAccessSubject): boolean =>
    skill.userId === subject.userId || (isSharedWithOrganization(skill, subject) && isSkillEditorRole(subject.organizationRole));

/** Deleting and re-scoping a skill are the owner's alone. */
export const isSkillOwner = (skill: SkillAccessTarget, subject: SkillAccessSubject): boolean => skill.userId === subject.userId;

/** Marketplace reads: public only, regardless of who owns it. */
export const isMarketplaceSkill = (skill: SkillAccessTarget | null | undefined): skill is SkillAccessTarget => !!skill && skillVisibility(skill) === "public";
