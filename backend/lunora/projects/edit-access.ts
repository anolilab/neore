/**
 * Who may change a project's settings (`updateProject`, its rule files): its owner only. A project nobody owns is
 * changed by nobody through them, organization members included. One rule for every path that changes them, the
 * writing transaction included (`agent.projects.updateProject`), so they cannot drift.
 */
export const mayEditProject = (project: { userId?: string | null }, userId: string): boolean => project.userId === userId;
