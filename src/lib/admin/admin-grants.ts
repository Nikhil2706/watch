/**
 * Who may be given or lose the site's admin access (users.is_admin: /admin
 * and /api/admin/* with their own sign-in). Any admin may grant it or take
 * it away, with two exceptions that stop the site losing its curators:
 *  - the owner's account always keeps it;
 *  - nobody removes their own (another admin has to), so an admin can't
 *    lock themselves out by a slip of the finger.
 *
 * Pure, so it is tested directly; the PATCH route and the Users list both ask it.
 */
export function adminChangeProblem(input: {
  grant: boolean;
  targetId: string;
  targetUsername: string;
  /** The signed-in admin making the change; null for the X-Admin-Key (scripts). */
  actorUserId: string | null;
  ownerUsername: string;
}): string | null {
  if (input.grant) return null;
  if (input.targetUsername.toLowerCase() === input.ownerUsername.toLowerCase()) {
    return `${input.targetUsername} is the owner's account and always keeps admin access.`;
  }
  if (input.actorUserId !== null && input.actorUserId === input.targetId) {
    return "You can't remove your own admin access; another admin has to.";
  }
  return null;
}
