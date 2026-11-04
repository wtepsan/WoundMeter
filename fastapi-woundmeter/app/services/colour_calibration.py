"""Colour reference detection and correction from the ruler's eight-patch strip.

Spatial and colour calibration are separate: AprilTags fix scale and perspective (ruler_geometry),
this module only measures colour. It never changes image geometry and never blocks a spatially
valid measurement.

Procedure (one photograph):
1. Locate each patch in template millimetres (colour profile), map an inset central rectangle to
   the original photograph through the inverse homography and sample original pixels there, so
   printed borders and resampling are avoided.
2. Robust statistics per patch: median colour, MAD-based non-uniformity (shadow, glare,
   obstruction), clipped fraction.
3. Neutral-patch white balance: per-channel gains in linear sRGB from the white and grey patches.
4. A 3 × 3 linear-sRGB matrix fitted by ridge regression shrunk towards those gains (8 patches,
   9 parameters, so the prior is required), checked by leave-one-out cross-validation and its
   condition number. A transform that does not reduce CIEDE2000 error is rejected.
5. ΔE00 before and after against the profile's reference values.

The default profile's references are the digital design values of the ruler artwork. They have not
been measured on a printed ruler, so every result is reported as UNVERIFIED_REFERENCE: an
experimental correction, not a validated colour calibration.
"""
from __future__ import annotations

import base64
import hashlib
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import yaml

from app.schemas.response import ColourPatchResponse, ColourResponse

from .errors import TemplateConfigurationError
from .ruler_template import RulerTemplate

PROCESSING_VERSION = "colour-calibration-v1"
VERIFIED = "VERIFIED"
NEUTRAL_NAMES = ("white", "grey", "black")


@dataclass(frozen=True)
class PatchSpec:
    name: str
    rectangle_mm: Tuple[float, float, float, float]  # x1, y1, x2, y2 (template mm, y up)
    reference_srgb: Tuple[float, float, float]


@dataclass(frozen=True)
class ColourProfile:
    profile_id: str
    version: str
    checksum: str
    ruler_template_id: str
    ruler_lengths_cm: Tuple[int, ...]
    colour_space: str
    reference_status: str
    reference_method: str
    provenance: str
    sampling_inset_fraction: float
    patches: Tuple[PatchSpec, ...]
    thresholds: Dict[str, float] = field(default_factory=dict)

    @property
    def verified(self) -> bool:
        return self.reference_status == VERIFIED


def load_colour_profile(path: Path) -> ColourProfile:
    raw = path.read_bytes()
    data = yaml.safe_load(raw)
    if not isinstance(data, dict) or not data.get("patches"):
        raise TemplateConfigurationError("Colour profile has no patches.")
    patches = []
    for item in data["patches"]:
        rect = tuple(float(v) for v in item["rectangle_mm"])
        ref = tuple(float(v) for v in item["reference_srgb"])
        if len(rect) != 4 or rect[0] >= rect[2] or rect[1] >= rect[3] or len(ref) != 3:
            raise TemplateConfigurationError(f"Invalid colour patch {item.get('name')}.")
        patches.append(PatchSpec(str(item["name"]), rect, ref))
    names = {p.name for p in patches}
    if not {"white", "grey"} <= names:
        raise TemplateConfigurationError("Colour profile needs white and grey patches for white balance.")
    return ColourProfile(
        profile_id=str(data["profile_id"]),
        version=str(data["version"]),
        checksum=hashlib.sha256(raw).hexdigest(),
        ruler_template_id=str(data["ruler_template_id"]),
        ruler_lengths_cm=tuple(int(v) for v in data["ruler_lengths_cm"]),
        colour_space=str(data["colour_space"]),
        reference_status=str(data["reference_status"]),
        reference_method=str(data["reference_method"]),
        provenance=str(data.get("provenance", "")),
        sampling_inset_fraction=float(data.get("sampling_inset_fraction", 0.25)),
        patches=tuple(patches),
        thresholds={k: float(v) for k, v in (data.get("thresholds") or {}).items()},
    )


# ---- Colour science -----------------------------------------------------------------------------

_SRGB_TO_XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                         [0.2126729, 0.7151522, 0.0721750],
                         [0.0193339, 0.1191920, 0.9503041]])
_D65_WHITE = np.array([0.95047, 1.0, 1.08883])


def srgb_to_linear(srgb_255: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(srgb_255, dtype=np.float64) / 255.0, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(linear: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(linear, dtype=np.float64), 0.0, 1.0)
    return 255.0 * np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


def linear_to_lab(linear: np.ndarray) -> np.ndarray:
    xyz = np.asarray(linear, dtype=np.float64) @ _SRGB_TO_XYZ.T / _D65_WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e00(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 colour difference (Sharma, Wu & Dalal 2005), kL = kC = kH = 1."""
    lab1, lab2 = np.asarray(lab1, dtype=np.float64), np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    c_bar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(c_bar ** 7 / (c_bar ** 7 + 25 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, c2p - c1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, np.where(dhp < -180, dhp + 360, dhp))
    dhp = np.where(c1p * c2p == 0, 0.0, dhp)
    dHp = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dhp) / 2)
    Lp_bar, Cp_bar = (L1 + L2) / 2, (c1p + c2p) / 2
    h_sum = h1p + h2p
    hp_bar = np.where(np.abs(h1p - h2p) > 180, np.where(h_sum < 360, (h_sum + 360) / 2, (h_sum - 360) / 2), h_sum / 2)
    hp_bar = np.where(c1p * c2p == 0, h_sum, hp_bar)
    t = (1 - 0.17 * np.cos(np.radians(hp_bar - 30)) + 0.24 * np.cos(np.radians(2 * hp_bar))
         + 0.32 * np.cos(np.radians(3 * hp_bar + 6)) - 0.20 * np.cos(np.radians(4 * hp_bar - 63)))
    d_theta = 30 * np.exp(-(((hp_bar - 275) / 25) ** 2))
    rc = 2 * np.sqrt(Cp_bar ** 7 / (Cp_bar ** 7 + 25 ** 7))
    sl = 1 + 0.015 * (Lp_bar - 50) ** 2 / np.sqrt(20 + (Lp_bar - 50) ** 2)
    sc = 1 + 0.045 * Cp_bar
    sh = 1 + 0.015 * Cp_bar * t
    rt = -np.sin(np.radians(2 * d_theta)) * rc
    return np.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh))


def _luminance(linear_rgb: np.ndarray) -> float:
    return float(np.asarray(linear_rgb) @ np.array([0.2126729, 0.7151522, 0.0721750]))


def _de(observed_linear: np.ndarray, reference_linear: np.ndarray) -> np.ndarray:
    return delta_e00(linear_to_lab(observed_linear), linear_to_lab(reference_linear))


# ---- Patch sampling -----------------------------------------------------------------------------

@dataclass
class PatchSample:
    spec: PatchSpec
    found: bool
    pixel_count: int = 0
    median_srgb: Optional[np.ndarray] = None
    clipped_fraction: float = 0.0
    non_uniformity: float = 0.0
    issue: Optional[str] = None


def _sample_patch(original_bgr: np.ndarray, inverse_h: np.ndarray, template: RulerTemplate,
                  spec: PatchSpec, inset: float, thresholds: Dict[str, float]) -> PatchSample:
    x1, y1, x2, y2 = spec.rectangle_mm
    dx, dy = (x2 - x1) * inset, (y2 - y1) * inset
    corners_mm = np.array([[x1 + dx, y1 + dy], [x2 - dx, y1 + dy], [x2 - dx, y2 - dy], [x1 + dx, y2 - dy]], np.float32)
    canonical_px = template.mm_to_px(corners_mm).reshape(-1, 1, 2)
    polygon = cv2.perspectiveTransform(canonical_px, inverse_h).reshape(-1, 2)
    height, width = original_bgr.shape[:2]
    if not np.all(np.isfinite(polygon)) or polygon[:, 0].min() < 0 or polygon[:, 1].min() < 0 \
            or polygon[:, 0].max() > width - 1 or polygon[:, 1].max() > height - 1:
        return PatchSample(spec, False, issue="outside_photo")
    left, top = np.floor(polygon.min(axis=0)).astype(int)
    right, bottom = np.ceil(polygon.max(axis=0)).astype(int) + 1
    region = original_bgr[top:bottom, left:right]
    mask = np.zeros(region.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, np.rint(polygon - [left, top]).astype(np.int32), 1)
    pixels = region[mask > 0][:, ::-1].astype(np.float64)  # RGB
    if len(pixels) < thresholds.get("min_patch_pixels", 30):
        return PatchSample(spec, False, pixel_count=len(pixels), issue="too_small_in_photo")
    median = np.median(pixels, axis=0)
    mad = 1.4826 * np.median(np.abs(pixels - median), axis=0)
    high = np.mean(np.any(pixels >= 254, axis=1))
    low = np.mean(np.any(pixels <= 1, axis=1)) if spec.name != "black" else 0.0
    sample = PatchSample(spec, True, pixel_count=len(pixels), median_srgb=median,
                         clipped_fraction=float(max(high, low)), non_uniformity=float(np.mean(mad)))
    if sample.clipped_fraction > thresholds.get("max_clipped_fraction", 0.2):
        sample.issue = "clipped_glare" if high >= low else "underexposed"
    elif sample.non_uniformity > thresholds.get("max_non_uniformity", 12.0):
        sample.issue = "non_uniform_shadow_or_obstruction"
    return sample


# ---- Correction fitting -------------------------------------------------------------------------

def _white_balance_gains(observed: np.ndarray, reference: np.ndarray) -> np.ndarray:
    # Least-squares per-channel gain through the origin over the neutral patches.
    return np.sum(observed * reference, axis=0) / np.maximum(np.sum(observed ** 2, axis=0), 1e-9)


def _ridge_matrix(observed: np.ndarray, reference: np.ndarray, prior_gains: np.ndarray, alpha: float) -> np.ndarray:
    """Rows m_c minimise |O m_c − R_c|² + λ|m_c − g_c e_c|², λ = α · trace(OᵀO) / 3."""
    gram = observed.T @ observed
    lam = alpha * np.trace(gram) / 3.0
    prior = np.diag(prior_gains)
    return np.linalg.solve(gram + lam * np.eye(3), observed.T @ reference + lam * prior).T


def apply_colour_transform(bgr: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """Apply a linear-sRGB 3 × 3 transform per pixel; geometry is untouched."""
    lut = srgb_to_linear(np.arange(256)).astype(np.float32)
    rgb_linear = lut[bgr[..., ::-1]]
    corrected = rgb_linear.reshape(-1, 3) @ matrix.T.astype(np.float32)
    out = linear_to_srgb(corrected).reshape(bgr.shape)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)[..., ::-1].copy()


@dataclass
class ColourCalibrationResult:
    response: ColourResponse
    corrected_canonical_bgr: Optional[np.ndarray] = None
    matrix: Optional[np.ndarray] = None


def calibrate_colour(
    original_bgr: np.ndarray,
    homography: np.ndarray,
    template: RulerTemplate,
    ruler_length_cm: int,
    profile: Optional[ColourProfile],
    canonical_bgr: Optional[np.ndarray] = None,
) -> ColourCalibrationResult:
    started = time.perf_counter()
    if profile is None or ruler_length_cm not in profile.ruler_lengths_cm or template.template_id != profile.ruler_template_id:
        return ColourCalibrationResult(ColourResponse(
            status="NOT_CONFIGURED", processing_version=PROCESSING_VERSION,
            warnings=["No colour-strip layout is configured for this ruler; colour was not calibrated."],
        ))
    t = profile.thresholds
    base = dict(profile_id=profile.profile_id, profile_version=profile.version,
                reference_status=profile.reference_status, reference_method=profile.reference_method,
                processing_version=PROCESSING_VERSION)
    inverse_h = np.linalg.inv(homography)
    samples = [_sample_patch(original_bgr, inverse_h, template, spec, profile.sampling_inset_fraction, t)
               for spec in profile.patches]

    def failed(reason: str) -> ColourCalibrationResult:
        return ColourCalibrationResult(ColourResponse(
            status="COLOUR_CALIBRATION_FAILED", patches=_patch_responses(samples), patches_found=_found(samples),
            warnings=[reason, "Colour-based tissue interpretation is not supported for this photograph."],
            processing_time_ms=round((time.perf_counter() - started) * 1000, 2), **base,
        ))

    usable = {s.spec.name: s for s in samples if s.found and s.issue is None}
    if not {"white", "grey"} <= set(usable):
        missing = [n for n in ("white", "grey") if n not in usable]
        return failed(f"Colour reference strip not usable: neutral patch(es) {', '.join(missing)} not found or unreadable.")

    neutral = [usable[n] for n in NEUTRAL_NAMES if n in usable and n != "black"]
    obs_n = srgb_to_linear(np.array([s.median_srgb for s in neutral]))
    ref_n = srgb_to_linear(np.array([s.spec.reference_srgb for s in neutral]))
    # Strip presence: grey must be clearly darker than white, by roughly the reference ratio. A
    # plain ruler arm (no strip), glare across the neutrals or a covering fails this, and colour
    # correction from such "neutrals" would be meaningless.
    ratio = _luminance(obs_n[1]) / max(_luminance(obs_n[0]), 1e-9)
    ratio_ref = _luminance(ref_n[1]) / max(_luminance(ref_n[0]), 1e-9)
    tolerance = t.get("neutral_contrast_tolerance", 2.0)
    if not (ratio_ref / tolerance <= ratio <= ratio_ref * tolerance):
        return failed(f"Colour reference strip not detected: the grey patch is not darker than the white patch by the "
                      f"expected amount (luminance ratio {ratio:.2f}, expected {ratio_ref:.2f}). The strip may be "
                      "missing, covered or under glare.")
    gains = _white_balance_gains(obs_n, ref_n)
    if not np.all(np.isfinite(gains)) or gains.min() <= 0 or gains.max() / gains.min() > t.get("max_gain_ratio", 4.0):
        return failed("White-balance gains from the neutral patches are implausible (strong cast or wrong patches).")

    # A uniform but wrong-coloured patch (covered by skin, a dressing or a finger) survives the
    # uniformity check; after white balance it is far from its reference, so it is excluded.
    for s in list(usable.values()):
        if s.spec.name in ("white", "grey"):
            continue
        observed_wb = srgb_to_linear(s.median_srgb) * gains
        if float(_de(observed_wb, srgb_to_linear(np.array(s.spec.reference_srgb)))) > t.get("max_patch_delta_e00_after_white_balance", 20.0):
            s.issue = "implausible_colour_possibly_covered"
            usable.pop(s.spec.name)

    names = [s.spec.name for s in samples if s.spec.name in usable]
    observed = srgb_to_linear(np.array([usable[n].median_srgb for n in names]))
    reference = srgb_to_linear(np.array([usable[n].spec.reference_srgb for n in names]))
    de_before = _de(observed, reference)
    de_wb = _de(observed * gains, reference)

    matrix, method, cond, loo = np.diag(gains), "white_balance_diagonal", None, None
    if len(names) >= t.get("min_valid_patches_for_matrix", 6):
        alpha = t.get("ridge_alpha", 0.1)
        candidate = _ridge_matrix(observed, reference, gains, alpha)
        cond = float(np.linalg.cond(candidate))
        loo_errors = []
        for i in range(len(names)):
            keep = np.arange(len(names)) != i
            m_i = _ridge_matrix(observed[keep], reference[keep], gains, alpha)
            loo_errors.append(float(_de(observed[i] @ m_i.T, reference[i])))
        loo = float(np.mean(loo_errors))
        de_matrix = _de(observed @ candidate.T, reference)
        if (cond <= t.get("max_matrix_condition_number", 25.0) and de_matrix.mean() < de_wb.mean()
                and loo < de_before.mean()):
            matrix, method = candidate, "ridge_3x3_linear_srgb_shrunk_to_white_balance"
    de_after = _de(observed @ matrix.T, reference)
    if de_after.mean() >= de_before.mean():
        return failed("No colour transform reduced the patch error; correction was not applied.")

    corrected_bgr = apply_colour_transform(canonical_bgr, matrix) if canonical_bgr is not None else None
    corrected_srgb = linear_to_srgb(observed @ matrix.T)
    for s in samples:
        if s.spec.name in usable:
            i = names.index(s.spec.name)
            s.de_before, s.de_after, s.corrected = float(de_before[i]), float(de_after[i]), corrected_srgb[i]

    complete = len(names) == len(profile.patches)
    mean_after, max_after = float(de_after.mean()), float(de_after.max())
    warnings: List[str] = []
    if not complete:
        warnings.append(f"{len(profile.patches) - len(names)} colour patch(es) excluded: "
                        + ", ".join(f"{s.spec.name} ({s.issue})" for s in samples if s.spec.name not in usable) + ".")
    within = mean_after <= t.get("calibrated_mean_delta_e00", 5.0) and max_after <= t.get("calibrated_max_delta_e00", 10.0)
    if not profile.verified:
        status = "UNVERIFIED_REFERENCE"
        warnings.append("Experimental colour correction: the reference values are the ruler artwork's design colours, "
                        "not measurements of the printed ruler. ΔE00 is relative to those design values.")
    elif within and len(names) >= t.get("min_valid_patches_for_matrix", 6):
        status = "COLOUR_CALIBRATED"
    else:
        status = "COLOUR_REVIEW_REQUIRED"
        warnings.append("Residual colour error is above the calibration threshold; consider another photograph.")
    interpretation = within and len(names) >= t.get("min_valid_patches_for_matrix", 6) and status in {"COLOUR_CALIBRATED", "UNVERIFIED_REFERENCE"}
    if not interpretation:
        warnings.append("Colour-based tissue interpretation is not supported for this photograph.")

    encoded = None
    if corrected_bgr is not None:
        ok, buffer = cv2.imencode(".jpg", corrected_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        encoded = base64.b64encode(buffer.tobytes()).decode("ascii") if ok else None
    return ColourCalibrationResult(
        ColourResponse(
            status=status, method=method, patches=_patch_responses(samples), patches_found=len(names),
            white_balance_gains=[round(float(g), 5) for g in gains],
            correction_matrix=[[round(float(v), 5) for v in row] for row in matrix],
            matrix_condition_number=round(cond, 3) if cond is not None else None,
            mean_delta_e00_before=round(float(de_before.mean()), 3), mean_delta_e00_after=round(mean_after, 3),
            max_delta_e00_after=round(max_after, 3), loo_mean_delta_e00=round(loo, 3) if loo is not None else None,
            correction_applied=True, colour_interpretation_allowed=bool(interpretation),
            corrected_canonical_image_base64=encoded, warnings=warnings,
            processing_time_ms=round((time.perf_counter() - started) * 1000, 2), **base,
        ),
        corrected_canonical_bgr=corrected_bgr,
        matrix=matrix,
    )


def _found(samples: List[PatchSample]) -> int:
    return sum(1 for s in samples if s.found and s.issue is None)


def _patch_responses(samples: List[PatchSample]) -> List[ColourPatchResponse]:
    def rounded(values) -> Optional[List[float]]:
        return None if values is None else [round(float(v), 1) for v in values]
    return [
        ColourPatchResponse(
            name=s.spec.name, found=s.found, pixel_count=s.pixel_count,
            observed_srgb=rounded(s.median_srgb), reference_srgb=rounded(s.spec.reference_srgb),
            corrected_srgb=rounded(getattr(s, "corrected", None)),
            clipped_fraction=round(s.clipped_fraction, 4) if s.found else None,
            non_uniformity=round(s.non_uniformity, 2) if s.found else None,
            delta_e00_before=round(getattr(s, "de_before"), 3) if hasattr(s, "de_before") else None,
            delta_e00_after=round(getattr(s, "de_after"), 3) if hasattr(s, "de_after") else None,
            issue=s.issue,
        )
        for s in samples
    ]
