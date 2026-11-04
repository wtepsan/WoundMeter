"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Home, Inbox, LogOut, Settings, UserRound, Users } from "lucide-react";

import { BrandMark } from "@/components/app/BrandMark";
import { CareDataProvider, useCareData, useReviewQueue } from "@/components/app/CareDataProvider";
import { NewObservation } from "@/components/care/NewObservation";
import { NewWound } from "@/components/care/NewWound";
import { PatientDashboard } from "@/components/care/PatientDashboard";
import { CarePlanPage } from "@/components/caregiver/CarePlanPage";
import { MyPatients } from "@/components/caregiver/MyPatients";
import { ObservationReview } from "@/components/clinical/ObservationReview";
import { PatientSearch, PatientsTabs } from "@/components/clinical/PatientSearch";
import { RegisterPatient } from "@/components/clinical/RegisterPatient";
import { ReviewQueue } from "@/components/clinical/ReviewQueue";
import { DemoTools } from "@/components/demo/DemoTools";
import { HomePage } from "@/components/home/HomePage";
import { ConnectionStatus } from "@/components/pwa/ConnectionStatus";
import { AdmissionReport } from "@/components/nursing/AdmissionReport";
import { NursingAssessment } from "@/components/nursing/NursingAssessment";
import { WardBoard } from "@/components/nursing/WardBoard";
import { SettingsPage, type SettingsSection } from "@/components/settings/SettingsPage";
import { EmptyState, Loading } from "@/components/ui/Feedback";
import { DEMO_MODE, can, accountName, isWardNurse, portalForRole, roleLabel, type Account, type Portal } from "@/lib/accounts";
import { LeaveDialog } from "@/components/ui/LeaveDialog";
import { discardUnsaved, hasUnsavedChanges } from "@/lib/navigation-guard";
import { hashToView, viewToHash } from "@/lib/routes";
import type { AssessmentType } from "@/lib/nursing-types";

export type View =
  | { name: "patients" }
  | { name: "register" }
  | { name: "patient"; patientId: string; woundId?: string }
  | { name: "new-wound"; patientId: string }
  | { name: "new-observation"; patientId: string; woundId?: string }
  | { name: "queue" }
  | { name: "review"; patientId: string; observationId: string }
  | { name: "ward" }
  | { name: "nursing-assessment"; patientId: string; admissionId: string; assessmentType: string }
  | { name: "admission-report"; patientId: string; admissionId: string }
  | { name: "account" }
  | { name: "studio" }
  | { name: "evidence" }
  | { name: "demo" }
  | { name: "home" }
  | { name: "submit" }
  | { name: "careplan" }
  | { name: "sharing" }
  | { name: "users" }
  | { name: "organisations" }
  | { name: "audit" };

export type Navigate = (view: View) => void;

type NavKey = "home" | "patients" | "reviews" | "settings";
type NavItem = { key: NavKey; view: View; label: string; icon: React.ElementType; match: View["name"][] };

const SETTINGS_VIEWS: View["name"][] = ["account", "sharing", "users", "organisations", "audit"];
const PATIENT_VIEWS: View["name"][] = ["patients", "register", "patient", "review", "new-wound", "new-observation", "ward", "nursing-assessment", "admission-report"];

/** Four destinations at most. Photo, AI, boundary, measurement, history and reports live inside the patient record. */
function navItems(portal: Portal): NavItem[] {
  const home: NavItem = { key: "home", view: { name: "home" }, label: "Home", icon: Home,
    match: portal === "patient" ? ["home", "careplan", "patient", "review"] : ["home", "submit", "careplan", "demo"] };
  const patients: NavItem = { key: "patients", view: { name: "patients" }, label: "Patients", icon: Users, match: PATIENT_VIEWS };
  const reviews: NavItem = { key: "reviews", view: { name: "queue" }, label: "Reviews", icon: Inbox, match: ["queue"] };
  const settings: NavItem = { key: "settings", view: { name: portal === "admin" ? "users" : "account" }, label: "Settings", icon: Settings, match: SETTINGS_VIEWS };
  if (portal === "clinical") return [home, patients, reviews, settings];
  if (portal === "caregiver") return [home, patients, settings];
  if (portal === "research") return [settings];
  return [home, settings];
}

const DEFAULT_VIEW: Record<Portal, View> = {
  admin: { name: "home" },
  clinical: { name: "home" },
  caregiver: { name: "home" },
  patient: { name: "home" },
  research: { name: "account" },
};

function PendingBadge() {
  const { pending } = useReviewQueue();
  if (pending.length === 0) return null;
  return (
    <span className="nav-count" aria-label={`${pending.length} awaiting review`}>
      {pending.length}
    </span>
  );
}

/** Patient portal home: the patient's own record. */
function OwnRecord({ account, navigate }: { account: Account; navigate: Navigate }) {
  const { patients } = useCareData();
  if (patients === null) return <Loading />;
  if (!patients[0]) {
    return (
      <div className="page">
        <EmptyState title="No record linked to this account">Ask your care team to link your record.</EmptyState>
      </div>
    );
  }
  return <PatientDashboard patientId={patients[0].patient_id} account={account} portal="patient" navigate={navigate} />;
}

function AccountMenu({ account, onAccount, onSignOut }: { account: Account; onAccount: () => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const name = accountName(account);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="account-button"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-avatar small" aria-hidden="true">
          {name.charAt(0)}
        </span>
        <span className="account-button-text">
          <span>{name}</span>
          <small>{roleLabel(account.role)}</small>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="dropdown-panel align-end">
          <div className="dropdown-header">
            <strong>{account.display_name}</strong>
            <span>
              {roleLabel(account.role)} · {account.org_name ?? account.org_id}
            </span>
          </div>
          <ul className="dropdown-list">
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAccount();
                }}
              >
                <UserRound aria-hidden="true" /> Profile & security
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                <LogOut aria-hidden="true" /> Sign out
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function ShellContent({ account, portal, onSignOut }: { account: Account; portal: Portal; onSignOut: () => void }) {
  // The address bar holds the screen (#/patients/…/wounds/…), so Back, reload and shared links keep the context.
  const [view, setView] = useState<View>(() => (typeof window === "undefined" ? null : hashToView(window.location.hash)) ?? DEFAULT_VIEW[portal]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const mainRef = useRef<HTMLElement>(null);

  const show = useCallback((next: View) => {
    setView(next);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }, []);

  // A screen with unsaved changes is left only after the user chooses Discard changes.
  const [leaving, setLeaving] = useState<View | null>(null);
  const go = useCallback((next: View) => {
    const hash = viewToHash(next);
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    show(next);
  }, [show]);
  const navigate = useCallback<Navigate>((next) => {
    if (hasUnsavedChanges()) setLeaving(next);
    else go(next);
  }, [go]);

  useEffect(() => {
    const onPop = () => {
      const target = hashToView(window.location.hash) ?? DEFAULT_VIEW[portal];
      if (hasUnsavedChanges()) {
        // Stay on the screen with unsaved edits (put its address back) and ask.
        window.history.pushState(null, "", viewToHash(viewRef.current));
        setLeaving(target);
        return;
      }
      show(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [portal, show]);

  // Reviews only for staff who can assess; administration never implies clinical review.
  const items = navItems(portal).filter((item) => item.key !== "reviews" || can(account, "ASSESS"));
  const currentKey = items.find((item) => item.match.includes(view.name))?.key;
  const home = DEFAULT_VIEW[portal];
  const wardNurse = portal === "clinical" && isWardNurse(account);
  const settings = (section: SettingsSection) => (
    <SettingsPage section={section} account={account} portal={portal} navigate={navigate} onSignOut={onSignOut} />
  );

  const content = (() => {
    switch (view.name) {
      case "home":
        return portal === "patient" ? <OwnRecord account={account} navigate={navigate} /> : <HomePage account={account} portal={portal} navigate={navigate} />;
      case "patients":
        if (portal === "caregiver") return <MyPatients navigate={navigate} />;
        if (portal !== "clinical") return <EmptyState title="Patient search is unavailable" />;
        return <PatientSearch account={account} navigate={navigate} tabs={wardNurse ? <PatientsTabs current="patients" navigate={navigate} /> : undefined} />;
      case "register":
        if (!can(account, "REGISTER_PATIENT")) return <EmptyState title="Patient registration is unavailable" />;
        return <RegisterPatient account={account} navigate={navigate} />;
      case "patient":
        return (
          <PatientDashboard
            key={view.patientId}
            patientId={view.patientId}
            initialWoundId={view.woundId}
            account={account}
            portal={portal}
            navigate={navigate}
          />
        );
      case "new-wound":
        if (portal !== "clinical" || !can(account, "REGISTER_WOUND")) return <EmptyState title="Wound registration is unavailable" />;
        return <NewWound key={view.patientId} patientId={view.patientId} account={account} navigate={navigate} />;
      case "new-observation":
        if (portal !== "caregiver" && !can(account, "CAPTURE")) return <EmptyState title="Capture is unavailable" />;
        return (
          <NewObservation
            key={`${view.patientId}-${view.woundId ?? ""}`}
            patientId={view.patientId}
            initialWoundId={view.woundId}
            account={account}
            portal={portal}
            navigate={navigate}
          />
        );
      case "queue":
        if (!can(account, "ASSESS")) return <EmptyState title="Clinical review is unavailable" />;
        return <ReviewQueue account={account} navigate={navigate} />;
      case "review":
        return (
          <ObservationReview
            key={view.observationId}
            patientId={view.patientId}
            observationId={view.observationId}
            account={account}
            navigate={navigate}
          />
        );
      case "ward":
        if (!wardNurse) return <EmptyState title="The ward board is unavailable" />;
        return <div className="page page-wide"><PatientsTabs current="ward" navigate={navigate} /><WardBoard navigate={navigate} /></div>;
      case "nursing-assessment":
        return (
          <NursingAssessment
            key={`${view.admissionId}-${view.assessmentType}`}
            patientId={view.patientId}
            admissionId={view.admissionId}
            assessmentType={view.assessmentType as AssessmentType}
            navigate={navigate}
          />
        );
      case "admission-report":
        return <AdmissionReport key={view.admissionId} patientId={view.patientId} admissionId={view.admissionId} navigate={navigate} />;
      case "account":
      case "sharing":
      case "users":
      case "organisations":
      case "audit":
        return settings(view.name);
      case "studio":
      case "evidence":
        return <EmptyState title="Research tools are unavailable">Use the authorised patient wound workflow.</EmptyState>;
      case "demo":
        return <DemoTools account={account} navigate={navigate} />;
      case "submit":
        // Former global "New photo update": a measure now always starts from a chosen patient and wound.
        return portal === "caregiver" ? <MyPatients navigate={navigate} /> : <HomePage account={account} portal={portal} navigate={navigate} />;
      case "careplan":
        return <CarePlanPage portal={portal} />;
    }
  })();

  return (
    <div className={`app portal-${portal}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <button type="button" className="brand-button" onClick={() => navigate(home)} aria-label="WoundMeter home">
            <BrandMark compact />
          </button>
          <nav className="primary-nav" aria-label="Main">
            <ul>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="nav-link"
                      aria-current={item.key === currentKey ? "page" : undefined}
                      onClick={() => navigate(item.view)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                      {item.key === "reviews" && <PendingBadge />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="topbar-end">
            {DEMO_MODE && (
              <button
                type="button"
                className="demo-chip"
                aria-current={view.name === "demo" ? "page" : undefined}
                onClick={() => navigate({ name: "demo" })}
                title="Demo mode: accounts and getting started"
              >
                Demo
              </button>
            )}
            <AccountMenu account={account} onAccount={() => navigate({ name: "account" })} onSignOut={onSignOut} />
          </div>
        </div>
        <ConnectionStatus />
      </header>
      <main id="main" className="app-main" tabIndex={-1} ref={mainRef}>
        {content}
      </main>
      <LeaveDialog open={leaving !== null} onKeep={() => setLeaving(null)}
        onDiscard={() => { const next = leaving; discardUnsaved(); setLeaving(null); if (next) go(next); }} />
      <footer className="app-footer">
        WoundMeter research prototype. AI assists; qualified clinicians verify and sign off. Not for independent clinical
        decisions.
      </footer>
    </div>
  );
}

export function AppShell({ account, onSignOut }: { account: Account; onSignOut: (notice?: string) => void }) {
  const portal = portalForRole(account.role);
  const signOut = useCallback(() => {
    // An explicit sign-out leaves no record address behind for the next person. (An expired session
    // keeps it, so signing in again returns to the same screen.)
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    onSignOut();
  }, [onSignOut]);
  const expire = useCallback(() => onSignOut("Your session ended. Please sign in again."), [onSignOut]);
  return (
    // Keyed per account so no cached records or view state carry over between people.
    <CareDataProvider
      key={account.subject}
      enabled={portal === "clinical" || portal === "caregiver" || portal === "patient"}
      withQueue={portal === "clinical" && can(account, "ASSESS")}
      onAuthExpired={expire}
    >
      <ShellContent account={account} portal={portal} onSignOut={signOut} />
    </CareDataProvider>
  );
}
