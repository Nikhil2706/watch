import type { Metadata } from "next";

import { AccoladesWorkspace } from "./AccoladesWorkspace";

export const metadata: Metadata = { title: "Accolades · Curator" };

export default function AdminAccoladesPage() {
  return <AccoladesWorkspace />;
}
