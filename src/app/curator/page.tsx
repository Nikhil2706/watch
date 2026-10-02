import { redirect } from "next/navigation";

/**
 * Picks lived here before they became lists with pages of their own. Kept as
 * a redirect: installed phone apps and old bookmarks still open /curator.
 */
export default function CuratorPage() {
  redirect("/picks");
}
