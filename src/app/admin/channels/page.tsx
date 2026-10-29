import type { Metadata } from "next";

import { ChannelsWorkspace } from "./ChannelsWorkspace";

export const metadata: Metadata = { title: "Channels · Curator" };

export default function AdminChannelsPage() {
  return <ChannelsWorkspace />;
}
