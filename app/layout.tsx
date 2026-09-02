import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Runway Alpha",
  description:
    "Airport investment intelligence: ranks US airports on how much profitable capacity a renovation would unlock.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
