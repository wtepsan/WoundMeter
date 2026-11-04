"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, UserPlus } from "lucide-react";

import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { Disclosure, PageHeader } from "@/components/ui/Layout";
import { admin, type AdminUser, type Organisation } from "@/lib/admin-api";
import { MEDICAL_ROLES, ROLE_OPTIONS, roleLabel, type PermissionPolicy } from "@/lib/accounts";
import { formatDateTime } from "@/lib/care-format";

function UserEditor({
  user,
  organisations,
  policy,
  onSaved,
}: {
  user: AdminUser;
  organisations: Organisation[];
  policy: PermissionPolicy;
  onSaved: (u: AdminUser) => void;
}) {
  const [role, setRole] = useState(user.role);
  const [orgId, setOrgId] = useState(user.org_id);
  const [active, setActive] = useState(user.active);
  const [title, setTitle] = useState(user.qualification_title ?? "");
  const [licence, setLicence] = useState(user.license_number ?? "");
  const [verified, setVerified] = useState(Boolean(user.qualification_verified_at));
  const [perms, setPerms] = useState<string[]>(user.granted_permissions);
  const [wards, setWards] = useState<string[]>(user.wards);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { role: useId(), org: useId(), title: useId(), licence: useId() };
  const medical = MEDICAL_ROLES.has(user.role);
  const qualificationVerified = Boolean(user.qualification_verified_at);
  const wardStaff = user.role === "NURSE" || user.role === "SUPERVISOR";
  const orgWards = organisations.find((o) => o.org_id === user.org_id)?.wards ?? [];

  const save = async (action: () => Promise<AdminUser>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await action();
      onSaved(updated);
      setPerms(updated.granted_permissions);
      setMessage({ tone: "success", text: success });
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof Error ? err.message : "Change refused." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack user-editor">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <section className="subsection">
        <h3>Role & organisation</h3>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.role}>Role</label>
            <select id={ids.role} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.org}>Organisation</label>
            <select id={ids.org} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {organisations.map((o) => (
                <option key={o.org_id} value={o.org_id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Account active</span>
        </label>
        <p className="fine-print">Changing role or organisation, or deactivating, signs the person out everywhere. Clinical permissions are removed if the role is no longer clinical.</p>
        <div className="button-row">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => save(() => admin.updateUser(user.subject, { role, org_id: orgId, active }), "Account updated.")}
          >
            Save role & organisation
          </button>
        </div>
      </section>

      {medical && (
        <section className="subsection">
          <h3>Professional qualification</h3>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={ids.title}>Qualification</label>
              <input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Registered Nurse" />
            </div>
            <div className="field">
              <label htmlFor={ids.licence}>Licence number</label>
              <input id={ids.licence} value={licence} onChange={(e) => setLicence(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
            <span>I have verified this qualification against the professional register</span>
          </label>
          <div className="button-row">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                save(() => admin.setQualification(user.subject, { title, license_number: licence, verified }), "Qualification saved.")
              }
            >
              Save qualification
            </button>
          </div>
        </section>
      )}

      {wardStaff && (
        <section className="subsection">
          <h3>Wards</h3>
          <p className="fine-print">Inpatient nursing (ward board, admissions, nursing assessments) is limited to these wards.</p>
          {orgWards.length === 0 ? (
            <p className="muted-text">This organisation has no inpatient wards.</p>
          ) : (
            <fieldset className="permission-grid" disabled={busy}>
              <legend className="sr-only">Wards</legend>
              {orgWards.map((w) => (
                <label key={w.ward_code} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={wards.includes(w.ward_code)}
                    onChange={(e) => setWards((prev) => (e.target.checked ? [...prev, w.ward_code] : prev.filter((x) => x !== w.ward_code)))}
                  />
                  <span>
                    {w.ward_code} — {w.name}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {orgWards.length > 0 && (
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => save(() => admin.updateUser(user.subject, { wards: wards.filter((w) => orgWards.some((o) => o.ward_code === w)) }), "Wards saved.")}
              >
                Save wards
              </button>
            </div>
          )}
        </section>
      )}

      <section className="subsection">
        <h3>Clinical permissions</h3>
        {!medical ? (
          <p className="muted-text">Clinical permissions apply to medical staff only. {user.role === "ADMIN" && "Administrators cannot hold them."}</p>
        ) : !qualificationVerified ? (
          <p className="muted-text">Verify the qualification first. Unverified staff have no clinical permissions.</p>
        ) : null}
        <p className="fine-print">Bundles include required lower-level actions. Diagnosis, prescribing, sign-off and governance require explicit grants. Saving revokes active sessions.</p>
        {medical && qualificationVerified && <div className="button-row">
          {Object.entries(policy.bundles).map(([key, bundle]) => <button key={key} type="button" className="button secondary small" disabled={busy}
            onClick={() => {
              const next = new Set(perms);
              const visited = new Set<string>();
              const include = (p: string) => { if (visited.has(p)) return; visited.add(p); next.add(p); (policy.dependencies[p] ?? []).forEach(include); };
              bundle.permissions.forEach(include);
              setPerms([...next]);
            }}>Add {bundle.label}</button>)}
        </div>}
        <fieldset className="permission-grid" disabled={!medical || !qualificationVerified || busy}>
          <legend className="sr-only">Clinical permissions</legend>
          {Object.keys(policy.permissions).map((p) => (
            <label key={p} className="checkbox-row">
              <input
                type="checkbox"
                checked={perms.includes(p)}
                onChange={(e) => setPerms((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))}
              />
              <span>
                {policy.permissions[p].label}
                <span className="cell-sub">{policy.permissions[p].detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {medical && qualificationVerified && (
          <div className="button-row">
            <button type="button" className="button secondary" disabled={busy} onClick={() => save(() => admin.setPermissions(user.subject, perms), "Permissions saved.")}>
              Save permissions
            </button>
          </div>
        )}
      </section>

      <section className="subsection">
        <h3>Password</h3>
        <InlineConfirm
          trigger="Reset password"
          triggerClassName="button ghost"
          title={`Set a temporary password for ${user.display_name}?`}
          description="Their current sessions are signed out. Share the temporary password securely and ask them to change it."
          confirmLabel="Set temporary password"
          tone="primary"
          reasonLabel="Temporary password (at least 10 characters)"
          busy={busy}
          onConfirm={(pw) => save(() => admin.resetPassword(user.subject, pw), "Temporary password set.")}
        />
      </section>
    </div>
  );
}

function CreateUser({ organisations, onCreated }: { organisations: Organisation[]; onCreated: (u: AdminUser) => void }) {
  const [form, setForm] = useState({ username: "", display_name: "", role: "NURSE", org_id: organisations[0]?.org_id ?? "", temporary_password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          onCreated(await admin.createUser(form));
          setForm((f) => ({ ...f, username: "", display_name: "", temporary_password: "" }));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't create the account.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-u`}>Username</label>
          <input id={`${id}-u`} value={form.username} onChange={set("username")} autoComplete="off" required />
        </div>
        <div className="field">
          <label htmlFor={`${id}-n`}>Full name</label>
          <input id={`${id}-n`} value={form.display_name} onChange={set("display_name")} required />
        </div>
        <div className="field">
          <label htmlFor={`${id}-r`}>Role</label>
          <select id={`${id}-r`} value={form.role} onChange={set("role")}>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-o`}>Organisation</label>
          <select id={`${id}-o`} value={form.org_id} onChange={set("org_id")}>
            {organisations.map((o) => (
              <option key={o.org_id} value={o.org_id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-p`}>Temporary password</label>
          <input id={`${id}-p`} type="password" value={form.temporary_password} onChange={set("temporary_password")} autoComplete="new-password" minLength={10} required />
        </div>
      </div>
      <p className="fine-print">New medical staff have no clinical permissions until their qualification is verified.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="button-row">
        <button type="submit" className="button primary" disabled={busy}>
          <UserPlus aria-hidden="true" /> Create account
        </button>
      </div>
    </form>
  );
}

export function UsersPage() {
  const [policy, setPolicy] = useState<PermissionPolicy | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [organisations, setOrganisations] = useState<Organisation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, o, p] = await Promise.all([admin.users(), admin.organisations(), admin.permissionPolicy()]);
      setPolicy(p);
      setUsers(u);
      setOrganisations(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load accounts.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);

  const replace = (u: AdminUser) => setUsers((prev) => (prev ? prev.map((x) => (x.subject === u.subject ? u : x)) : prev));
  const current = users?.find((u) => u.subject === selected) ?? null;

  return (
    <div className="page page-wide">
      <PageHeader title="Users & roles" subtitle="Accounts, roles, organisation membership and verified clinical permissions." />
      {error && <Notice tone="danger">{error}</Notice>}
      {!users || !policy ? (
        <Loading />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Organisation</th>
                  <th scope="col">Qualification</th>
                  <th scope="col">Clinical permissions</th>
                  <th scope="col">Sign-in</th>
                  <th scope="col">
                    <span className="sr-only">Edit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.subject} aria-selected={u.subject === selected}>
                    <td data-label="Person">
                      <strong>{u.display_name}</strong>
                      <span className="cell-sub mono">{u.username}</span>
                    </td>
                    <td data-label="Role">{roleLabel(u.role)}</td>
                    <td data-label="Organisation">{u.org_name}</td>
                    <td data-label="Qualification">
                      {MEDICAL_ROLES.has(u.role) ? (
                        <Badge tone={u.qualification_verified_at ? "success" : "warning"}>{u.qualification_verified_at ? "Verified" : "Not verified"}</Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-label="Clinical permissions">{u.effective_permissions.length ? u.effective_permissions.map((p) => policy.permissions[p]?.label ?? p).join(", ") : "None"}</td>
                    <td data-label="Sign-in">
                      <span className="badge-stack">
                        {!u.active && <Badge tone="danger">Inactive</Badge>}
                        {u.locked && <Badge tone="warning">Locked</Badge>}
                        {u.requires_mfa && <Badge tone="neutral">MFA</Badge>}
                      </span>
                      <span className="cell-sub">{u.last_login_at_utc ? `Last ${formatDateTime(u.last_login_at_utc)}` : "Never signed in"}</span>
                    </td>
                    <td className="cell-action">
                      <button type="button" className="button ghost small" onClick={() => setSelected(u.subject === selected ? null : u.subject)} aria-expanded={u.subject === selected}>
                        {u.subject === selected ? "Close" : "Manage"} <ChevronRight aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current && (
            <section className="panel" aria-label={`Manage ${current.display_name}`} ref={editorRef}>
              <h2 className="section-title">
                {current.display_name} <span className="muted-text">({current.username})</span>
              </h2>
              <UserEditor key={current.subject} user={current} organisations={organisations} policy={policy} onSaved={replace} />
            </section>
          )}
          <Disclosure title="Add a user">
            <CreateUser organisations={organisations} onCreated={(u) => setUsers((prev) => (prev ? [...prev, u] : [u]))} />
          </Disclosure>
        </>
      )}
    </div>
  );
}
