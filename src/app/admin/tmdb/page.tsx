import type { Metadata } from "next";

import { TmdbWorkspace } from "./TmdbWorkspace";

export const metadata: Metadata = { title: "TMDB · Curator" };

export default function AdminTmdbPage() {
  return <TmdbWorkspace />;
}
