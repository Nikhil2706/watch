import type { Metadata } from "next";

import { LibraryWorkspace } from "./LibraryWorkspace";

export const metadata: Metadata = { title: "Library · Curator" };

export default function AdminLibraryPage() {
  return <LibraryWorkspace />;
}
