from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


ReviewWorkflowState = Literal[
    "IMAGE_CAPTURED",
    "AI_PROCESSING",
    "AI_MEASUREMENT_READY",
    "PENDING_HUMAN_MEASUREMENT_REVIEW",
    "RETAKE_REQUIRED",
    "MEASUREMENT_REJECTED",
    "HUMAN_CORRECTION",
    "MEASUREMENT_ACCEPTED",
    "CLINICAL_DRAFT",
    "PENDING_CLINICAL_REVIEW",
    "RETURNED_FOR_EDIT",
    "REJECTED",
    "CLINICIAN_CONFIRMED",
    "FINAL_SUBMITTED_RECORD",
]

SegmentationMode = Literal["yolo", "sam", "compare"]
BoundaryProvenance = Literal["ai_predicted", "human_corrected", "human_accepted"]


class ImageQualityResponse(BaseModel):
    status: str
    warnings: List[str] = Field(default_factory=list)
    original_width_px: Optional[int] = None
    original_height_px: Optional[int] = None


class RulerResponse(BaseModel):
    dictionary: Literal["APRILTAG_36h11"] = "APRILTAG_36h11"
    detected_ids: List[int] = Field(default_factory=list)
    template_id: Optional[str] = None
    template_version: Optional[str] = None
    template_checksum: Optional[str] = None
    pixels_per_mm: Optional[float] = None
    validated: bool = False
    length_marker_id: Optional[int] = None
    ruler_length_cm: Optional[float] = None
    calibration_source: Optional[str] = None


class GeometryResponse(BaseModel):
    status: str
    canonical_width_px: Optional[int] = None
    canonical_height_px: Optional[int] = None
    inner_bounds_px: Optional[List[int]] = None
    mean_reprojection_error_mm: Optional[float] = None
    maximum_reprojection_error_mm: Optional[float] = None
    per_tag_error_mm: Dict[str, float] = Field(default_factory=dict)
    inlier_count: Optional[int] = None
    all_tags_contributed: bool = False
    warnings: List[str] = Field(default_factory=list)
    # Set when part of the ruler's square lies outside the photo: the photo's edges in canonical pixels.
    photo_coverage_px: Optional[List[List[float]]] = None


ColourStatus = Literal[
    "not_attempted",
    "NOT_CONFIGURED",
    "COLOUR_CALIBRATED",
    "COLOUR_REVIEW_REQUIRED",
    "UNVERIFIED_REFERENCE",
    "COLOUR_CALIBRATION_FAILED",
]


class ColourPatchResponse(BaseModel):
    name: str
    found: bool = False
    pixel_count: int = 0
    observed_srgb: Optional[List[float]] = None
    reference_srgb: Optional[List[float]] = None
    corrected_srgb: Optional[List[float]] = None
    clipped_fraction: Optional[float] = None
    non_uniformity: Optional[float] = None
    delta_e00_before: Optional[float] = None
    delta_e00_after: Optional[float] = None
    issue: Optional[str] = None


class ColourResponse(BaseModel):
    # Colour quality is reported independently of spatial calibration: a colour failure never
    # invalidates a geometrically valid measurement.
    status: ColourStatus = "not_attempted"
    warnings: List[str] = Field(default_factory=list)
    profile_id: Optional[str] = None
    profile_version: Optional[str] = None
    reference_status: Optional[str] = None
    reference_method: Optional[str] = None
    processing_version: Optional[str] = None
    method: Optional[str] = None
    patches: List[ColourPatchResponse] = Field(default_factory=list)
    patches_found: int = 0
    white_balance_gains: Optional[List[float]] = None
    correction_matrix: Optional[List[List[float]]] = None
    matrix_condition_number: Optional[float] = None
    mean_delta_e00_before: Optional[float] = None
    mean_delta_e00_after: Optional[float] = None
    max_delta_e00_after: Optional[float] = None
    loo_mean_delta_e00: Optional[float] = None
    correction_applied: bool = False
    colour_interpretation_allowed: bool = False
    corrected_canonical_image_base64: Optional[str] = None
    processing_time_ms: Optional[float] = None


class SegmentationCandidateResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    candidate_id: int
    source_model: str
    # SAM guided strategy: "sam_refined_whole_wound" or "sam_concept" (alternative boundary). None for YOLO.
    boundary_kind: Optional[str] = None
    confidence: Optional[float] = None
    bounding_box_px: Optional[List[int]] = None
    canonical_boundary_px: List[List[int]] = Field(default_factory=list)
    canonical_mask_png_base64: Optional[str] = None
    measurements: Optional["MeasurementsResponse"] = None


class SegmentationResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str = "not_attempted"
    model_version: Optional[str] = None
    model_checksum: Optional[str] = None
    preprocessing_version: str = "canonical-inner-roi-v1"
    input_width_px: Optional[int] = None
    input_height_px: Optional[int] = None
    mask_mapping_method: str = "retina-mask-nearest-neighbour-v1"
    confidence: Optional[float] = None
    mask_threshold: Optional[float] = None
    wound_count: int = 0
    canonical_boundary_px: List[List[int]] = Field(default_factory=list)
    canonical_mask_png_base64: Optional[str] = None
    inference_time_ms: Optional[float] = None
    prompt_used: Optional[str] = None
    error_message: Optional[str] = None
    candidates: List[SegmentationCandidateResponse] = Field(default_factory=list)
    selected_candidate_id: Optional[int] = None
    # How a SAM boundary was obtained (concept pass, seeds, spatial pass); None for YOLO.
    sam_guidance: Optional[Dict[str, Any]] = None
    input_image: str = "original"


class MeasurementsResponse(BaseModel):
    area_cm2: float
    length_cm: float
    length_method: str
    width_cm: float
    width_method: str
    perimeter_cm: Optional[float] = None
    algorithm_version: str
    length_line_px: List[List[float]]
    width_line_px: List[List[float]]
    # Clinically oriented Feret major axis & perpendicular width (added alongside ruler-axis chords)
    clinical_length_cm: Optional[float] = None
    clinical_length_method: str = "maximum_feret_major_axis"
    clinical_width_cm: Optional[float] = None
    clinical_width_method: str = "maximum_perpendicular_span_to_major_axis"
    clinical_length_line_px: List[List[float]] = Field(default_factory=list)
    clinical_width_line_px: List[List[float]] = Field(default_factory=list)
    canonical_grid_spacing_mm: float = 0.1
    sampling_disclosure: str = (
        "Sampled on a 10 px/mm (0.1 mm) canonical homography grid; grid spacing is not "
        "equivalent to 0.1 mm physical or clinical measurement accuracy."
    )


class CanonicalImageResponse(BaseModel):
    media_type: Literal["image/jpeg"] = "image/jpeg"
    width_px: int
    height_px: int
    data_base64: str


class ModelComparisonResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["completed", "partial", "unavailable"] = "unavailable"
    primary_model: str = "YOLOv8-seg (best.pt)"
    secondary_model: str = "Meta SAM 3.1 (sam-3.1)"
    dice_coefficient: Optional[float] = None
    iou: Optional[float] = None
    area_diff_cm2: Optional[float] = None
    area_diff_pct: Optional[float] = None
    perimeter_diff_cm: Optional[float] = None
    length_diff_cm: Optional[float] = None
    width_diff_cm: Optional[float] = None
    yolo_latency_ms: Optional[float] = None
    sam_latency_ms: Optional[float] = None
    agreement_level: Literal["high", "moderate", "low_disagreement_warning", "not_applicable"] = "not_applicable"
    disagreement_warning: Optional[str] = None
    interpretation_note: str = (
        "Model agreement metrics (Dice/IoU) measure consistency between YOLO and Meta SAM 3.1 "
        "predictions on this photograph, not clinical accuracy. Human boundary verification is required."
    )


class MuseExplanationResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["ready", "fallback_deterministic", "unavailable"] = "unavailable"
    model_id: str = "muse-spark-1.3"
    disclaimer: str = "AI-generated draft — requires medical professional review."
    measurement_summary: str = ""
    segmentation_explanation: str = ""
    measurement_limitations: str = ""
    historical_comparison: str = ""
    documentation_draft: str = ""
    questions_for_reviewer: List[str] = Field(default_factory=list)
    latency_ms: Optional[float] = None
    error_message: Optional[str] = None


class HumanCorrectionRecord(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    was_corrected: bool = False
    base_model_source: Literal["yolo", "sam"] = "yolo"
    correction_source: Literal["none", "polygon_edit", "sam_prompt", "model_switch"] = "none"
    original_boundary_px: List[List[int]] = Field(default_factory=list)
    original_mask_png_base64: Optional[str] = None
    original_measurements: Optional[MeasurementsResponse] = None
    corrected_boundary_px: List[List[int]] = Field(default_factory=list)
    corrected_mask_png_base64: Optional[str] = None
    corrected_measurements: Optional[MeasurementsResponse] = None
    dice_vs_original_ai: Optional[float] = None
    iou_vs_original_ai: Optional[float] = None
    area_delta_cm2: Optional[float] = None
    area_delta_pct: Optional[float] = None
    correction_actions_count: int = 0
    correction_duration_ms: Optional[float] = None
    correction_notes: Optional[str] = None
    corrected_at_utc: Optional[str] = None
    corrected_by_subject: Optional[str] = None
    accuracy_epistemic_note: str = (
        "Difference between original AI and human-corrected masks quantifies reviewer boundary "
        "adjustment. Without an independent reference ground truth for this photograph, a mask "
        "difference alone does not establish an improvement in true physical accuracy."
    )


class QualityGateResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["PASS", "REVIEW_REQUIRED", "RETAKE_REQUIRED"] = "PASS"
    blocking_reasons: List[str] = Field(default_factory=list)
    review_reasons: List[str] = Field(default_factory=list)
    checks: Dict[str, str] = Field(default_factory=dict)
    contour_touches_measurement_edge: bool = False
    meta_execution_status: Literal[
        "live_api_connected",
        "sam_live_inference",
        "yolo_local_fallback",
        "cached_demo_result",
        "api_unavailable",
        "sam_no_valid_mask",
        "local_yolo_only",
    ] = "local_yolo_only"
    threshold_basis_note: str = (
        "Quality gate thresholds are engineering safety heuristics for planar ruler detection "
        "and inter-model consistency, not clinically validated diagnostic confidence intervals."
    )


class ProvenanceMetadata(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    system_name: str = "WoundMeter"
    prototype_notice: str = (
        "WoundMeter is an AI-assisted research prototype. Measurements and AI outputs "
        "require review by qualified medical personnel and are not a substitute for professional clinical assessment."
    )
    measurement_status: Literal[
        "provisional",
        "accepted_for_assessment",
        "rejected",
        "retake_required",
        "clinician_confirmed",
        "research_demo_attestation",
    ] = "provisional"
    review_state: ReviewWorkflowState = "PENDING_HUMAN_MEASUREMENT_REVIEW"
    boundary_provenance: BoundaryProvenance = "ai_predicted"
    active_model_source: str = "yolo"
    segmentation_mode: SegmentationMode = "yolo"
    yolo_model_version: Optional[str] = None
    yolo_model_checksum: Optional[str] = None
    sam_model_version: Optional[str] = None
    reasoning_model_version: Optional[str] = None
    measurement_algorithm_version: str = "measurement-v2-ruler-axes"
    ruler_template_version: Optional[str] = None
    ruler_template_checksum: Optional[str] = None
    created_at_utc: Optional[str] = None
    stage1_reviewed_by: Optional[str] = None
    stage1_reviewer_role: Optional[str] = None
    stage1_reviewed_at_utc: Optional[str] = None
    stage2_confirmed_by: Optional[str] = None
    stage2_reviewer_role: Optional[str] = None
    stage2_confirmed_at_utc: Optional[str] = None
    is_clinician_approved: bool = False


class ClinicalAssessmentRecord(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    assessment_id: str
    request_id: str
    version: int = 1
    prior_assessment_id: Optional[str] = None
    review_state: ReviewWorkflowState = "CLINICAL_DRAFT"
    is_clinician_approved: bool = False
    attestation_mode: Literal["clinician_authenticated", "research_demo_only"] = "research_demo_only"

    # Wound identity
    patient_code: str
    admission_code: Optional[str] = None
    ward_code: str = "WARD01"
    wound_id: str
    anatomical_location: str
    laterality: str = "NOT_APPLICABLE"
    assessment_datetime_utc: str

    # Clinical observations (entered strictly by medical staff, never inferred by AI)
    wound_type: str
    pressure_injury_stage: str = "NOT_APPLICABLE"
    wound_bed_appearance: str
    exudate_amount: str
    exudate_type: str = "NOT_APPLICABLE"
    surrounding_skin: str
    skin_status: str = "STABLE"
    wound_trend: str = "STABLE"
    pain_score_0_10: Optional[int] = None
    pain_issue: str = "NO"
    moisture_issue: str = "NO"
    mobility_issue: str = "INDEPENDENT"
    red_flag_present: bool = False
    new_abnormality: bool = False
    infection_signs_observed_by_staff: bool = False
    other_clinical_findings: str = ""

    # Braden Scale subscales & server-calculated score
    sensory_perception: int = Field(default=3, ge=1, le=4)
    moisture: int = Field(default=3, ge=1, le=4)
    activity: int = Field(default=3, ge=1, le=4)
    mobility: int = Field(default=3, ge=1, le=4)
    nutrition: int = Field(default=3, ge=1, le=4)
    friction_and_shear: int = Field(default=2, ge=1, le=3)
    braden_total: int = 17
    braden_risk_band: str = "MILD"

    # Priority calculation & nurse confirmation/override
    system_priority: Literal["RED", "YELLOW", "GREEN"] = "GREEN"
    nurse_priority: Literal["RED", "YELLOW", "GREEN"] = "GREEN"
    priority_override: bool = False
    override_reason: Optional[str] = None
    priority_reason_codes: List[str] = Field(default_factory=list)

    # Human evaluation & AI draft disposition
    staff_observations: str = ""
    clinical_interpretation: str = ""
    care_decisions: str = ""
    ai_draft_received: Optional[str] = None
    ai_draft_disposition: Literal["not_used", "accepted", "edited", "rejected"] = "not_used"
    final_documentation_text: str = ""

    # Measurement snapshot at confirmation
    accepted_measurements: Optional[MeasurementsResponse] = None
    segmentation_source: str = "yolo"
    was_human_corrected: bool = False
    calibration_validated: bool = False

    # Reviewer identity & timestamps
    reviewed_by_subject: Optional[str] = None
    reviewed_by_name: Optional[str] = None
    reviewer_role: Optional[str] = None
    submitted_at_utc: Optional[str] = None


class WoundMeasureResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    request_id: str
    overall_status: str
    image_quality: ImageQualityResponse
    ruler: RulerResponse
    geometry: GeometryResponse
    colour: ColourResponse = Field(default_factory=ColourResponse)
    segmentation: SegmentationResponse = Field(default_factory=SegmentationResponse)
    measurements: Optional[MeasurementsResponse] = None
    canonical_image: Optional[CanonicalImageResponse] = None
    warnings: List[str] = Field(default_factory=list)
    error_code: Optional[str] = None
    failure_stage: Optional[
        Literal["image_validation", "ruler_detection", "ruler_geometry", "wound_detection"]
    ] = None
    retake_guidance: List[str] = Field(default_factory=list)
    message: Optional[str] = None

    # Human-in-the-loop additions (all defaulted for 100% backward compatibility)
    quality_gate: QualityGateResponse = Field(default_factory=QualityGateResponse)
    yolo_segmentation: Optional[SegmentationResponse] = None
    yolo_measurements: Optional[MeasurementsResponse] = None
    sam_segmentation: Optional[SegmentationResponse] = None
    sam_measurements: Optional[MeasurementsResponse] = None
    model_comparison: Optional[ModelComparisonResponse] = None
    human_correction: Optional[HumanCorrectionRecord] = None
    ai_explanation: Optional[MuseExplanationResponse] = None
    clinical_assessment: Optional[ClinicalAssessmentRecord] = None
    provenance: ProvenanceMetadata = Field(default_factory=ProvenanceMetadata)
    audit_trail: List[Dict[str, Any]] = Field(default_factory=list)


SegmentationCandidateResponse.model_rebuild()
