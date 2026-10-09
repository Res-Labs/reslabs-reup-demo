import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo Store",
  description: "Testnet demo store. Orders are placed by agents after a verified tap.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="banner" role="note">
          Testnet demo, no real orders
        </div>
        <header className="site-header">
          <a className="brand" href="/">
            Demo Store
          </a>
          <nav className="nav">
            <a href="/">Product</a>
            <a href="/orders">Orders</a>
          </nav>
        </header>
        <p className="ruo">For research use only</p>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
