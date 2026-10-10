import type { Metadata } from "next";
import { Geist, Inter } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import "@/components/arc/foundation.css";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Demo Store",
  description: "Testnet demo store. Orders are placed by agents after a verified tap.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-accent="blue"
      className={`${geist.variable} ${inter.variable}`}
    >
      <body>
        <div className="page">
          <header className="site-header">
            <div className="brand-row">
              <Link className="brand" href="/">
                Demo Store
              </Link>
              <Badge>For research use only</Badge>
            </div>
            <SiteNav />
          </header>
          <Alert title="Testnet demo, no real orders">
            Payments use testnet pathUSD on Tempo. Nothing is charged or shipped.
          </Alert>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
