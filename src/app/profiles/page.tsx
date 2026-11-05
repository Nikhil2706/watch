import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { WhoIsWatching } from "@/components/WhoIsWatching";
import { parseDeviceAccounts } from "@/lib/device-accounts";
import { ACCOUNTS_COOKIE, resolveDeviceAccounts, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * "Who's watching?" — everyone signed in on this device, one press each.
 *
 * Opened from the account menu, after someone signs out while others stay
 * signed in, and on a TV by middleware when it is picked up after a while
 * (device-accounts.ts). Each tile is a session that signed in on this device;
 * ended ones are simply not shown (the switch route forgets them).
 */
export default async function ProfilesPage() {
  const store = await cookies();
  const active = store.get(SESSION_COOKIE)?.value ?? null;
  const saved = parseDeviceAccounts(store.get(ACCOUNTS_COOKIE)?.value);
  const { accounts } = resolveDeviceAccounts(active && !saved.includes(active) ? [...saved, active] : saved);

  if (accounts.length === 0) redirect("/login");

  return (
    <AuthShell pitch={false}>
      <WhoIsWatching
        accounts={accounts.map((a) => ({ userId: a.userId, username: a.username, active: a.sessionId === active }))}
      />
    </AuthShell>
  );
}
