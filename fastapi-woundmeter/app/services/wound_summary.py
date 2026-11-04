"""Wound care summary: the care planned now, progress, documented issues and the next action.

Built only from one wound entry of ConnectedCareService.get_patient_complete_record, i.e. from the
records that viewer is already authorised to read, so a caregiver's or patient's summary can only
contain their own projection. Deterministic: no model is called here. Verified facts, reported
concerns and AI drafts stay apart:

- Progress compares the latest clinician-approved measurement only with an earlier approved
  measurement of the same recorded boundary region. A measurement whose region was never recorded is
  shown on its own, never compared. Area change is a measured fact, never "healing"; the trend is the
  signing clinician's judgement and is shown as theirs.
- Issues are documented items only. AI visual observations never become issues.
- Care now is the active clinician-issued care plan; nothing is inferred when there is none.

Progress-summary narratives are versioned clinical reports in their own series (SUMMARY_SERIES_PREFIX),
drafted by Muse Spark or a clinician and signed through the existing report sign-off.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

SUMMARY_SERIES_PREFIX = "WSM-"
NO_CARE_PLAN = "No approved care plan available."
NOT_SCHEDULED = "Not scheduled."
OPEN_DRAFT_STATES = ("AI_DRAFT", "CLINICIAN_EDITED")
REGION_TEXT = {"whole_wound": "whole wound", "red_tissue": "red tissue only"}
FACT_KEYS = ("pain_score_0_10", "drainage_level", "dressing_condition", "redness_observed", "concern_reported",
             "non_diagnostic_notes")
# Inline record references such as "(V3, A2)": kept for staff, removed from caregiver/patient text.
_REFS = re.compile(r"\s*\((?:\s*(?:V|A|CR|AO|N)\d+\s*[,;]?)+\)")


def strip_refs(text: Optional[str]) -> str:
    return _REFS.sub("", text or "").strip()


def comparable_regions(a: Optional[str], b: Optional[str]) -> bool:
    """Two measurements are compared only when both outline the same recorded region. Whole wound and red
    tissue only are different measurements. A region that was never recorded (older edits, local-model
    boundaries) could be either, so it is never presumed to match, not even another unrecorded one: those
    measurements stay visible without a change figure. Mirrors regionsComparable() in care-format.ts."""
    return a is not None and a == b


def _when(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.combine(date.fromisoformat(text[:10]), datetime.min.time())
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _concern_text(facts: Dict[str, Any]) -> Optional[str]:
    """What a factual report flags, by the record's own concern rules (pain >= 6, redness, explicit concern)."""
    found = []
    pain = facts.get("pain_score_0_10")
    if isinstance(pain, int) and not isinstance(pain, bool) and pain >= 6:
        found.append(f"pain {pain}/10")
    if facts.get("redness_observed") == "YES":
        found.append("new redness")
    if facts.get("concern_reported") or facts.get("concern_flag"):
        return "a concern" + (f": {', '.join(found)}" if found else "")
    return ", ".join(found) or None


def _day(value: str) -> str:
    """'2026-11-02T…' -> '2 Nov 2026' (UTC date, as stored)."""
    parsed = _when(value)
    return f"{parsed.day} {parsed.strftime('%b %Y')}" if parsed else str(value)[:10]


def narrative_version(row: Dict[str, Any], names: Dict[str, str]) -> Dict[str, Any]:
    """One progress-summary version (a clinical_reports row in the summary series), for staff."""
    sections = json.loads(row["sections_json"])
    evidence = json.loads(row["evidence_json"])
    progress = sections.get("progress") or {}
    visits = evidence.get("approved_visits") or []
    ai_ids = progress.get("ai_revision_ids") or []
    return {
        "report_id": row["report_id"], "version_number": row["version_number"], "status": row["status"],
        "generator": row["generator"], "supersedes_report_id": row.get("supersedes_report_id"),
        "created_by": {"subject": row["created_by_subject"], "name": names.get(row["created_by_subject"]) or row["created_by_subject"]},
        "created_at_utc": row["created_at_utc"],
        "text": progress.get("text", ""), "source": progress.get("source", "record"),
        "source_refs": progress.get("source_refs") or [], "ai_assisted": bool(ai_ids), "ai_revision_ids": ai_ids,
        "signed_by_name": row.get("signed_by_name"), "signed_by_role": row.get("signed_by_role"),
        "signed_at_utc": row.get("signed_at_utc"), "content_sha256": row.get("content_sha256"),
        "rejection_reason": row.get("rejection_reason"),
        "revision_reason": (sections.get("_revision") or {}).get("text"),
        "based_on_observation_id": evidence.get("latest_observation_id") or (visits[-1]["observation_id"] if visits else None),
        "consistency": json.loads(row["consistency_json"] or "null"),
    }


def summarise_narratives(rows: Iterable[Dict[str, Any]], names: Dict[str, str], clinical: bool) -> Dict[str, Any]:
    """Approved progress summary for everyone; the open draft and full version history for staff only."""
    versions = sorted((narrative_version(r, names) for r in rows), key=lambda v: (v["created_at_utc"], v["version_number"]))
    signed = [v for v in versions if v["status"] == "SIGNED"]
    for earlier, later in zip(signed, signed[1:]):
        earlier["superseded_by"] = later["report_id"]
    approved = signed[-1] if signed else None
    if not clinical:
        return {"approved": {"text": strip_refs(approved["text"]), "version_number": approved["version_number"],
                             "signed_by_name": approved["signed_by_name"], "signed_by_role": approved["signed_by_role"],
                             "signed_at_utc": approved["signed_at_utc"],
                             "based_on_observation_id": approved["based_on_observation_id"]} if approved else None}
    draft = versions[-1] if versions and versions[-1]["status"] in OPEN_DRAFT_STATES else None
    return {"approved": approved, "draft": draft, "versions": list(reversed(versions))}


def _person(subject: Optional[str], names: Dict[str, str], role: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not subject:
        return None
    person: Dict[str, Any] = {"subject": subject, "name": names.get(subject) or subject}
    if role:
        person["role"] = role
    return person


def progress_facts_text(latest: Optional[Dict[str, Any]], previous: Optional[Dict[str, Any]],
                        change: Optional[Dict[str, Any]], trend: Optional[Dict[str, Any]], earlier_count: int) -> str:
    """Two plain sentences from verified facts only (UTC dates). Used as Muse evidence and as the starting
    text of a draft when Muse is unavailable."""
    if not latest:
        return "No clinician-verified measurement is recorded yet."
    region = REGION_TEXT.get(latest["region"], "boundary region not recorded")
    first = f"Latest verified area {latest['area_cm2']:.2f} cm² ({region}) on {_day(latest['date_utc'])}"
    if previous and change:
        if abs(change["cm2"]) < 0.005:
            first += f", unchanged from {previous['area_cm2']:.2f} cm² on {_day(previous['date_utc'])}."
        else:
            size = "smaller" if change["cm2"] < 0 else "larger"
            pct = f" ({abs(change['pct']):.1f}%)" if change["pct"] is not None else ""
            first += f", {abs(change['cm2']):.2f} cm²{pct} {size} than {previous['area_cm2']:.2f} cm² on {_day(previous['date_utc'])}."
    elif earlier_count and not latest["region"]:
        first += "; its boundary region was not recorded, so it is not compared with other measurements."
    elif earlier_count:
        first += "; no earlier verified measurement has the same recorded region, so there is no comparison."
    else:
        first += "; this is the first verified measurement."
    if trend:
        who = ", ".join(p for p in (trend.get("assessed_by_name"), str(trend.get("assessed_by_role") or "").lower()) if p)
        second = f"Clinician-assessed trend: {str(trend['value']).replace('_', ' ').lower()}" + (f" ({who})." if who else ".")
    else:
        second = "No clinician assessment of the trend is recorded."
    return f"{first} {second}"


def build_wound_summary(wound: Dict[str, Any], *, clinical: bool, viewer_subject: str, names: Dict[str, str],
                        review_requests: Iterable[Dict[str, Any]] = (), narratives: Optional[Dict[str, Any]] = None,
                        now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    today = now.date().isoformat()
    timeline = wound.get("approved_timeline") or []
    observations = list(wound.get("observations") or [])
    by_id = {o["observation_id"]: o for o in observations}
    refs = {p["observation_id"]: f"V{i + 1}" for i, p in enumerate(timeline)}
    requests = {r["observation_id"]: r for r in review_requests}

    # ---- Latest verified measurement and the comparable previous one (same region only) -------------
    latest = previous = change = None
    excluded = unrecorded = 0
    if timeline:
        point = timeline[-1]
        region = point.get("measurement_region")
        latest = {"observation_id": point["observation_id"], "ref": refs[point["observation_id"]],
                  "date_utc": point["capture_datetime_utc"], "area_cm2": round(point["area_cm2"], 2),
                  "length_cm": round(point["length_cm"], 2), "width_cm": round(point["width_cm"], 2),
                  "perimeter_cm": round(point["perimeter_cm"], 2) if point.get("perimeter_cm") is not None else None,
                  "region": region, "source_model": point.get("source_model"),
                  "boundary_edited_by_clinician": bool(point.get("was_human_corrected")),
                  "verified_by": _person(point.get("reviewing_clinician_subject"), names)}
        earlier = timeline[:-1]
        match = next((p for p in reversed(earlier) if comparable_regions(p.get("measurement_region"), region)), None)
        excluded = sum(1 for p in earlier if p.get("measurement_region") and p.get("measurement_region") != region)
        unrecorded = sum(1 for p in earlier if p.get("measurement_region") is None)
        if match:
            previous = {"observation_id": match["observation_id"], "ref": refs[match["observation_id"]],
                        "date_utc": match["capture_datetime_utc"], "area_cm2": round(match["area_cm2"], 2),
                        "region": match.get("measurement_region")}
            delta = round(point["area_cm2"] - match["area_cm2"], 2)
            start, end = _when(match["capture_datetime_utc"]), _when(point["capture_datetime_utc"])
            change = {"cm2": delta, "pct": round(100 * delta / match["area_cm2"], 1) if match["area_cm2"] > 0 else None,
                      "days": (end - start).days if start and end else None}

    # ---- Clinician-assessed trend (the latest approved visit's signed assessment) ---------------------
    trend = None
    latest_obs = by_id.get(latest["observation_id"]) if latest else None
    assessment = (latest_obs or {}).get("latest_clinical_assessment")
    if assessment and assessment.get("wound_trend"):
        trend = {"value": assessment["wound_trend"], "observation_id": latest_obs["observation_id"],
                 "assessed_at_utc": assessment.get("signed_at_utc"), "assessed_by_name": assessment.get("signed_by_name"),
                 "assessed_by_role": assessment.get("signed_by_role")}

    # ---- Review state ---------------------------------------------------------------------------------
    newest_first = sorted(observations, key=lambda o: o["capture_datetime_utc"], reverse=True)
    pending = [o for o in newest_first if o["review_state"] == "AWAITING_CLINICAL_REVIEW"]
    revisions = [o for o in newest_first if clinical and o["review_state"] == "CLINICIAN_APPROVED" and o.get("record_has_draft")]
    # A photo request stays open until a newer photo of this wound exists.
    retake = newest_first[0] if newest_first and newest_first[0]["review_state"] == "RETAKE_REQUESTED" else None
    if pending:
        own = not clinical
        state = {"code": "PENDING_REVIEW", "tone": "warning", "count": len(pending),
                 "label": ("Update awaiting review" if own else
                           f"{len(pending)} photo{'s' if len(pending) > 1 else ''} awaiting review")}
    elif retake:
        state = {"code": "PHOTO_REQUESTED", "tone": "warning", "count": 1, "label": "New photo requested"}
    elif revisions:
        state = {"code": "REVISION_PENDING", "tone": "warning", "count": len(revisions), "label": "Revision awaiting sign-off"}
    elif timeline:
        state = {"code": "UP_TO_DATE", "tone": "success", "count": 0, "label": "All measures reviewed"}
    else:
        state = {"code": "NO_VERIFIED_MEASUREMENT", "tone": "neutral", "count": 0, "label": "No verified measurement"}

    # ---- Care now: the active clinician-issued plan ---------------------------------------------------
    plan = next((p for p in wound.get("care_plans") or [] if p.get("status") == "ACTIVE"), None)
    tasks = [t for t in wound.get("care_tasks") or [] if plan and t.get("care_plan_id") == plan["care_plan_id"]]
    if plan:
        care_now = {"available": True, "care_plan_id": plan["care_plan_id"], "version_number": plan["version_number"],
                    "title": plan["title"], "purpose": plan["purpose"], "instructions": plan["approved_instructions"],
                    "frequency": plan["task_frequency"],
                    "responsible_clinician": _person(plan["responsible_clinician_subject"], names),
                    "assigned_caregiver": _person(plan.get("assigned_caregiver_subject"), names),
                    "approved_at_utc": plan.get("approved_at_utc"), "start_date": plan.get("start_date"),
                    "review_date": plan.get("review_date"),
                    "review_overdue": bool(plan.get("review_date") and plan["review_date"] < today),
                    "pending_tasks": sum(1 for t in tasks if t.get("status") == "PENDING")}
    else:
        care_now = {"available": False, "message": NO_CARE_PLAN}

    # ---- Issues: documented items only ----------------------------------------------------------------
    issues: List[Dict[str, Any]] = []
    for obs in newest_first:
        if obs["review_state"] not in ("AWAITING_CLINICAL_REVIEW", "RETAKE_REQUESTED"):
            continue  # an approved or rejected visit's report has been reviewed by a clinician
        facts = {**(obs.get("caregiver_report") or {}),
                 **{k: v for k, v in (obs.get("record_draft") or {}).items() if k in FACT_KEYS}}
        found = _concern_text(facts)
        if found:
            who = ("You reported " if not clinical and obs.get("uploading_user_subject") == viewer_subject
                   else "Caregiver reported " if obs.get("uploading_user_role") == "FAMILY_CAREGIVER" else "Reported at capture: ")
            issues.append({"kind": "reported_concern", "status": "reported", "observation_id": obs["observation_id"],
                           "label": who + found,
                           "detail": (facts.get("non_diagnostic_notes") or "").strip()[:300] or None,
                           "date_utc": obs["capture_datetime_utc"]})
    for obs in pending:
        request = requests.get(obs["observation_id"]) or {}
        issues.append({"kind": "pending_review", "status": "pending", "observation_id": obs["observation_id"],
                       "label": "Photo awaiting clinical review" if clinical else "Your update is awaiting review",
                       "priority": "high" if request.get("priority_level") == "RED" else None,
                       "date_utc": obs["capture_datetime_utc"]})
    for obs in revisions:
        issues.append({"kind": "revision_pending", "status": "pending", "observation_id": obs["observation_id"],
                       "label": "Revised record awaiting sign-off", "date_utc": obs["capture_datetime_utc"]})
    if retake:
        request = requests.get(retake["observation_id"]) or {}
        issues.append({"kind": "photo_requested", "status": "pending", "observation_id": retake["observation_id"],
                       "label": "New photo requested", "detail": retake.get("review_notes") if clinical else None,
                       "date_utc": request.get("reviewed_at_utc") or retake["capture_datetime_utc"]})
    for task in tasks:
        if task.get("status") == "CONCERN_REPORTED":
            issues.append({"kind": "task_concern", "status": "reported", "task_id": task["task_id"],
                           "label": f"Concern reported on task: {task['title']}",
                           "detail": (task.get("caregiver_notes") or "").strip()[:300] or None,
                           "date_utc": task.get("completed_at_utc")})
        elif task.get("status") == "PENDING" and (_when(task.get("due_at_utc")) or now) < now:
            issues.append({"kind": "task_overdue", "status": "documented", "task_id": task["task_id"],
                           "label": f"Overdue task: {task['title']}", "date_utc": task.get("due_at_utc")})
    if clinical and plan and care_now["review_overdue"]:
        issues.append({"kind": "plan_review_overdue", "status": "documented", "label": "Care plan review overdue",
                       "date_utc": plan["review_date"]})
    if clinical and latest_obs is not None and latest_obs.get("image_integrity_verified") is False:
        issues.append({"kind": "image_integrity", "status": "missing", "observation_id": latest_obs["observation_id"],
                       "label": "Latest verified photo failed the image integrity check",
                       "detail": "New signatures that rely on it are blocked.", "date_utc": latest_obs["capture_datetime_utc"]})
    if not timeline and observations and not pending and not retake:
        issues.append({"kind": "no_verified_measurement", "status": "missing", "label": "No verified measurement yet"})
    order = {"reported": 0, "pending": 1, "documented": 2, "missing": 3}
    issues.sort(key=lambda i: order[i["status"]])

    # ---- Next documented actions ----------------------------------------------------------------------
    actions: List[Dict[str, Any]] = []
    if retake:
        actions.append({"kind": "photo_requested", "label": "Take a new photo",
                        "responsible": _person(retake["uploading_user_subject"], names), "due_utc": None,
                        "observation_id": retake["observation_id"]})
    if pending:
        oldest = pending[-1]
        actions.append({"kind": "clinical_review", "label": "Review the new photo" if clinical else "Care team review of your update",
                        "responsible": {"name": "Care team"}, "due_utc": None, "since_utc": oldest["capture_datetime_utc"],
                        "count": len(pending), "observation_id": oldest["observation_id"]})
    if revisions:
        actions.append({"kind": "sign_revision", "label": "Sign off the revised record",
                        "responsible": {"name": "Clinician with sign-off"}, "due_utc": None,
                        "observation_id": revisions[-1]["observation_id"]})
    draft = (narratives or {}).get("draft") if clinical else None
    if draft:
        actions.append({"kind": "sign_summary", "label": "Review the progress summary draft",
                        "responsible": {"name": "Clinician with sign-off"}, "due_utc": None, "report_id": draft["report_id"]})
    upcoming = sorted((t for t in tasks if t.get("status") == "PENDING"), key=lambda t: t.get("due_at_utc") or "")
    for task in upcoming[:2]:
        due = _when(task.get("due_at_utc"))
        actions.append({"kind": "care_task", "label": task["title"], "frequency": task.get("frequency"),
                        "responsible": _person(plan.get("assigned_caregiver_subject"), names) if plan else None,
                        "due_utc": task.get("due_at_utc"), "overdue": bool(due and due < now), "task_id": task["task_id"]})
    if plan and plan.get("review_date"):
        actions.append({"kind": "plan_review", "label": "Care plan review",
                        "responsible": _person(plan["responsible_clinician_subject"], names),
                        "due_utc": plan["review_date"], "overdue": care_now["review_overdue"]})

    # ---- Progress narrative (signed summary) and its freshness ----------------------------------------
    narrative = dict((narratives or {}).get("approved") or {}) or None
    if narrative:
        narrative["current"] = bool(latest) and narrative.get("based_on_observation_id") == latest["observation_id"]

    summary = {
        "as_of_utc": now.isoformat(),
        "latest_verified": latest,
        "trend": trend,
        "latest_assessment_at_utc": trend["assessed_at_utc"] if trend else None,
        "review_state": state,
        "care_now": care_now,
        "progress": {
            "latest": latest, "previous_same_region": previous, "change": change,
            "compared": bool(previous),
            "not_compared_reason": None if previous or not latest else (
                "first_measurement" if not timeline[:-1] else
                "region_not_recorded" if not latest["region"] else "different_region"),
            "facts_text": progress_facts_text(latest, previous, change, trend, len(timeline) - 1 if timeline else 0),
            "narrative": narrative,
        },
        "issues": issues,
        "next_actions": actions,
        "measurement_details": {
            "approved_visit_count": len(timeline), "region": latest["region"] if latest else None,
            "excluded_other_region": excluded, "unrecorded_region": unrecorded,
            "image_integrity_verified": (latest_obs or {}).get("image_integrity_verified") if clinical else None,
            "notice": wound.get("healing_epistemic_notice"),
        },
    }
    if clinical and narratives is not None:
        summary["narrative_draft"] = narratives.get("draft")
        summary["narrative_versions"] = narratives.get("versions") or []
    return summary
