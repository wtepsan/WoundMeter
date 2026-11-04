from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.services.database_storage import storage_root


APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT.parent


def _load_dotenv_files() -> None:
    """Load only the private repository-root .env; existing process variables win."""
    candidates = [
        REPO_ROOT / ".env",
    ]
    for env_path in candidates:
        if not env_path.is_file():
            continue
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ and value != "<PRIVATE_ROTATED_KEY>":
                    os.environ[key] = value
        except OSError:
            continue


_load_dotenv_files()


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_float_env(name: str) -> Optional[float]:
    value = os.getenv(name)
    return None if value is None or not value.strip() else float(value)


def _resolve_meta_api_key() -> Optional[str]:
    for env_name in ("META_API_KEY", "META_API", "MODEL_API_KEY"):
        raw = os.getenv(env_name)
        if raw and raw.strip() and raw.strip() != "<PRIVATE_ROTATED_KEY>":
            return raw.strip()
    return None


@dataclass(frozen=True)
class Settings:
    model_path: Path = Path(os.getenv("WOUND_MODEL_PATH", APP_ROOT / "yolo_model" / "best.pt"))
    ruler_template_path: Path = Path(
        os.getenv("RULER_TEMPLATE_PATH", APP_ROOT / "config" / "ruler_template_v1.yaml")
    )
    colour_profile_path: Path = Path(
        os.getenv("COLOUR_PROFILE_PATH", APP_ROOT / "config" / "colour_profile_v1.yaml")
    )
    max_upload_bytes: int = int(os.getenv("MAX_UPLOAD_BYTES", 10 * 1024 * 1024))
    max_image_pixels: int = int(os.getenv("MAX_IMAGE_PIXELS", 24_000_000))
    min_image_dimension_px: int = int(os.getenv("MIN_IMAGE_DIMENSION_PX", 480))
    persist_uploads: bool = _bool_env("PERSIST_UPLOADS", False)
    results_dir: Path = field(default_factory=lambda: storage_root(os.getenv("RESULTS_DIR", str(APP_ROOT / "results"))))
    session_secret: str = field(
        default=os.getenv("SESSION_SECRET", "local-session-secret-change-before-shared-use"),
        repr=False,
    )
    # Inpatient nursing: the "clinical day" for required daily assessments.
    clinical_timezone: str = os.getenv("CLINICAL_TIMEZONE", "Asia/Bangkok")
    yolo_image_size: int = int(os.getenv("YOLO_IMAGE_SIZE", 768))
    yolo_confidence: float = float(os.getenv("YOLO_CONFIDENCE", 0.20))
    mask_threshold: float = float(os.getenv("MASK_THRESHOLD", 0.50))
    blur_variance_min: Optional[float] = _optional_float_env("BLUR_VARIANCE_MIN")
    max_underexposed_fraction: Optional[float] = _optional_float_env("MAX_UNDEREXPOSED_FRACTION")
    max_overexposed_fraction: Optional[float] = _optional_float_env("MAX_OVEREXPOSED_FRACTION")

    # Meta Model API configuration (server-side only)
    meta_api_key: Optional[str] = field(default_factory=_resolve_meta_api_key, repr=False)
    meta_api_base_url: str = os.getenv("META_API_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
    meta_reasoning_model: str = os.getenv("META_REASONING_MODEL", "muse-spark-1.3")
    meta_segmentation_model: str = os.getenv("META_SEGMENTATION_MODEL", "sam-3.1")
    meta_ai_enabled: bool = _bool_env("META_AI_ENABLED", False)
    meta_timeout_seconds: float = float(os.getenv("META_API_TIMEOUT_SECONDS", "28.0"))
    meta_max_concurrency: int = int(os.getenv("META_MAX_CONCURRENCY", "4"))
    meta_transcription_model: str = os.getenv("META_TRANSCRIPTION_MODEL", "muse-voice-transcribe-1.0")
    # Per-feature switches; each also requires META_AI_ENABLED and a key.
    meta_observations_enabled: bool = _bool_env("META_OBSERVATIONS_ENABLED", True)
    meta_reports_enabled: bool = _bool_env("META_REPORTS_ENABLED", True)
    meta_assistant_enabled: bool = _bool_env("META_ASSISTANT_ENABLED", True)
    meta_voice_enabled: bool = _bool_env("META_VOICE_ENABLED", True)
    # Muse Spark 1.3 accepts minimal|low|medium|high|xhigh|max; interactive clinical features use low.
    meta_reasoning_effort: str = os.getenv("META_REASONING_EFFORT", "low")
    # Reports are longer structured prose; low effort once produced irrelevant list text (see docs).
    meta_report_reasoning_effort: str = os.getenv("META_REPORT_REASONING_EFFORT", "medium")
    # Muse Spark reads longer prompts (reports, tool loops) than a SAM call; separate time budget.
    meta_reasoning_timeout_seconds: float = float(os.getenv("META_REASONING_TIMEOUT_SECONDS", "45.0"))

    # Authentication & patient-identifier protection
    demo_mode: bool = _bool_env("WOUNDMETER_DEMO_MODE", False)
    # /demo photos kept in their own folder (never the database or patient uploads); demo mode only.
    demo_keep_photos: bool = _bool_env("WOUNDMETER_DEMO_KEEP_PHOTOS", False)
    demo_photo_dir: Path = Path(os.getenv("WOUNDMETER_DEMO_PHOTO_DIR", "/app/demo-data/images"))
    password_hash_iterations: int = int(os.getenv("PASSWORD_HASH_ITERATIONS", 600_000))
    session_absolute_ttl_seconds: int = int(os.getenv("SESSION_ABSOLUTE_TTL_SECONDS", 8 * 3600))
    session_idle_ttl_seconds: int = int(os.getenv("SESSION_IDLE_TTL_SECONDS", 30 * 60))
    max_failed_logins: int = int(os.getenv("MAX_FAILED_LOGINS", 5))
    patient_data_key: Optional[str] = field(default=os.getenv("PATIENT_DATA_KEY"), repr=False)
    patient_index_key: Optional[str] = field(default=os.getenv("PATIENT_INDEX_KEY"), repr=False)
    # Test-only: accept an unsigned `actor_subject`. Deliberately not readable from the environment.
    allow_unsigned_actor_subject: bool = False

    @property
    def meta_configured(self) -> bool:
        return bool(self.meta_ai_enabled and self.meta_api_key)


settings = Settings()
