import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements as adminDefaultStatements } from "better-auth/plugins/admin/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
// Define access control statements for resources
// Combines organization statements with custom project statements
const statement = {
    ...defaultStatements,
    ...adminDefaultStatements,
    billing: ["read", "update"],
    projects: ["create", "update", "delete"],
    team: ["create", "update", "delete", "manage_members"],
    teamSettings: ["read", "update"],
} as const;

export const ac = createAccessControl(statement);

/**
 * Member role - basic organization member permissions
 * Can create and update projects, but not delete
 * Can read billing info
 */
const member = ac.newRole({
    ...memberAc.statements,
    billing: ["read"],
    projects: ["create", "update"],
});

/**
 * Owner role - full organization owner permissions
 * Can create, update, and delete projects
 * Full billing and team management access
 */
const owner = ac.newRole({
    ...ownerAc.statements,
    billing: ["read", "update"],
    projects: ["create", "update", "delete"],
    team: ["create", "update", "delete", "manage_members"],
    teamSettings: ["read", "update"],
});

/**
 * Admin role - organization administrator permissions
 * Can read billing, manage teams and settings
 */
const admin = ac.newRole({
    ...adminAc.statements,
    ...ownerAc.statements,
    billing: ["read"],
    projects: ["create", "update", "delete"],
    team: ["create", "update", "manage_members"],
    teamSettings: ["read", "update"],
});

export const roles = { admin, member, owner };
