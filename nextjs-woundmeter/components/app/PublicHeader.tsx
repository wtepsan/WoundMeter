import Link from "next/link";
import { BookOpen, FlaskConical, Home } from "lucide-react";

import { BrandMark } from "@/components/app/BrandMark";
import { DEMO_MODE } from "@/lib/accounts";

/** Header for the pages outside the signed-in app (/demo, /instruction): the logo returns to the main page. */
export function PublicHeader({ current }: { current: "demo" | "instruction" }) {
  const links = [
    { href: "/", label: "Home", icon: Home, key: "home" },
    { href: "/instruction", label: "Photo guide", icon: BookOpen, key: "instruction" },
    ...(DEMO_MODE ? [{ href: "/demo", label: "Demo", icon: FlaskConical, key: "demo" }] : []),
  ];
  return (
    <header className="public-header">
      <div className="public-header-inner">
        <Link href="/" className="brand-button" aria-label="WoundMeter home">
          <BrandMark compact />
        </Link>
        <nav aria-label="WoundMeter pages" className="public-nav">
          {links.map(({ href, label, icon: Icon, key }) => (
            <Link key={key} href={href} className="public-nav-link" aria-current={key === current ? "page" : undefined}>
              <Icon aria-hidden="true" /> {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
