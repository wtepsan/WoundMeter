"""Rule-based clinical scores shared by wound sign-off and inpatient nursing assessments.

Single implementation of the Braden Scale and the RED/YELLOW/GREEN priority rules that were
previously duplicated in the nurse-form API (`domain/braden.py`, `domain/priority.py`) and the
wound review workflow. The version strings are stored with every assessment and keep their
original values so existing records stay comparable.
"""
from __future__ import annotations

from typing import List, Tuple

BRADEN_VERSION = "braden-v1"
PRIORITY_RULE_VERSION = "woundwise-v1"
PRIORITY_RANK = {"GREEN": 0, "YELLOW": 1, "RED": 2}
SUGGESTED_REVIEW_MINUTES = {"RED": 30, "YELLOW": 120, "GREEN": 240}


def calculate_braden_score(
    sensory_perception: int,
    moisture: int,
    activity: int,
    mobility: int,
    nutrition: int,
    friction_and_shear: int,
) -> Tuple[int, str]:
    """Braden total (6–23) and risk band; every subscale is validated server-side."""
    ranges = [
        ("sensory_perception", sensory_perception, 1, 4),
        ("moisture", moisture, 1, 4),
        ("activity", activity, 1, 4),
        ("mobility", mobility, 1, 4),
        ("nutrition", nutrition, 1, 4),
        ("friction_and_shear", friction_and_shear, 1, 3),
    ]
    for name, score, lo, hi in ranges:
        if not (lo <= score <= hi):
            raise ValueError(f"{name} must be between {lo} and {hi}")
    total = sum(score for _, score, _, _ in ranges)
    if total <= 9:
        band = "VERY_HIGH"
    elif total <= 12:
        band = "HIGH"
    elif total <= 14:
        band = "MODERATE"
    elif total <= 18:
        band = "MILD"
    else:
        band = "NO_CURRENT_RISK"
    return total, band


def calculate_clinical_priority(
    *,
    red_flag_present: bool = False,
    new_abnormality: bool = False,
    skin_status: str = "STABLE",
    wound_trend: str = "STABLE",
    pain_issue: str = "NO",
    moisture_issue: str = "NO",
    mobility_issue: str = "INDEPENDENT",
    overdue_critical_activity: bool = False,
) -> Tuple[str, List[str]]:
    """System priority and the reasons that triggered it. A suggestion only: the nurse confirms or overrides."""
    red_reasons: List[str] = []
    if red_flag_present:
        red_reasons.append("RED_FLAG_PRESENT")
    if new_abnormality:
        red_reasons.append("NEW_ABNORMALITY")
    if skin_status == "WORSENING":
        red_reasons.append("SKIN_OR_WOUND_WORSENING")
    if wound_trend == "WORSENING":
        red_reasons.append("WOUND_WORSENING")
    if wound_trend == "NEW_WOUND":
        red_reasons.append("NEW_WOUND")
    if overdue_critical_activity:
        red_reasons.append("CRITICAL_ACTIVITY_OVERDUE")
    if red_reasons:
        return "RED", red_reasons

    yellow_reasons: List[str] = []
    if skin_status == "REDNESS":
        yellow_reasons.append("SKIN_REDNESS")
    if pain_issue == "YES_UNCONTROLLED":
        yellow_reasons.append("UNCONTROLLED_PAIN")
    if moisture_issue == "YES_UNMANAGED":
        yellow_reasons.append("UNMANAGED_MOISTURE")
    if mobility_issue == "DEPENDENT":
        yellow_reasons.append("DEPENDENT_MOBILITY")
    if yellow_reasons:
        return "YELLOW", yellow_reasons

    return "GREEN", ["STABLE_NO_URGENT_TRIGGER"]


def override_direction(system_priority: str, nurse_priority: str) -> str:
    if system_priority == nurse_priority:
        return "NOT_APPLICABLE"
    return "UPGRADE" if PRIORITY_RANK[nurse_priority] > PRIORITY_RANK[system_priority] else "DOWNGRADE"
