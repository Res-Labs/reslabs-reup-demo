"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Product" },
  { href: "/orders", label: "Orders" },
] as const;

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={pathname === link.href ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
