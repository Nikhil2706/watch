import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Watch",
  description: "Private media library.",
  // Invite links get pasted into chat apps that follow URLs. Keep them out of
  // any index and out of link previews.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
