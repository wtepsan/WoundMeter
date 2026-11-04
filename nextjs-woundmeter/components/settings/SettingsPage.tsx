"use client";

import { Building2, ScrollText, Share2, UserCog, UserRound } from "lucide-react";

import type { Navigate, View } from "@/components/app/AppShell";
import { AccountPage } from "@/components/account/AccountPage";
import { AuditPage } from "@/components/admin/AuditPage";
import { OrganisationsPage } from "@/components/admin/OrganisationsPage";
import { UsersPage } from "@/components/admin/UsersPage";
import { SharingPage } from "@/components/care/SharingPage";
import type { Account, Portal } from "@/lib/accounts";

export type SettingsSection = "account" | "sharing" | "users" | "organisations" | "audit";

const SECTIONS: Array<{ key: SettingsSection; label: string; icon: React.ElementType; portals: Portal[] }> = [
  { key: "account", label: "Profile & security", icon: UserRound, portals: ["admin", "clinical", "caregiver", "patient", "research"] },
  { key: "sharing", label: "Sharing", icon: Share2, portals: ["patient"] },
  { key: "users", label: "Users & roles", icon: UserCog, portals: ["admin"] },
  { key: "organisations", label: "Organisations & access", icon: Building2, portals: ["admin"] },
  { key: "audit", label: "Security & audit", icon: ScrollText, portals: ["admin"] },
];

/** One Settings destination: personal settings for everyone, administration for administrators only. */
export function SettingsPage({ section, account, portal, navigate, onSignOut }: {
  section: SettingsSection; account: Account; portal: Portal; navigate: Navigate; onSignOut: () => void;
}) {
  const available = SECTIONS.filter((s) => s.portals.includes(portal));
  const current = available.find((s) => s.key === section) ?? available[0];
  return (
    <div className={`settings-layout${available.length > 1 ? "" : " is-single"}`}>
      {available.length > 1 && (
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="settings-nav-title">Settings</p>
          <ul>
            {available.map(({ key, label, icon: Icon }) => (
              <li key={key}>
                <button type="button" aria-current={key === current.key ? "page" : undefined} onClick={() => navigate({ name: key } as View)}>
                  <Icon aria-hidden="true" /> <span>{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className="settings-content">
        {current.key === "account" && <AccountPage account={account} portal={portal} navigate={navigate} onSignOut={onSignOut} />}
        {current.key === "sharing" && <SharingPage />}
        {current.key === "users" && <UsersPage />}
        {current.key === "organisations" && <OrganisationsPage />}
        {current.key === "audit" && <AuditPage />}
      </div>
    </div>
  );
}
