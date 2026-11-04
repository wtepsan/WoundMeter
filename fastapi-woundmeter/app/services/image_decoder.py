from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import Settings

from .errors import ProcessingFailure


SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}
_SIGNATURES = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n")


def _open(data: bytes) -> Image.Image:
    """Open an upload with the three supported decoders only. Pillow would otherwise try every plugin it
    has (PSD, PDF, FITS, font and other parsers) just to identify the file, before the format check."""
    try:
        return Image.open(BytesIO(data), formats=sorted(SUPPORTED_FORMATS))
    except UnidentifiedImageError as exc:
        if data.startswith(_SIGNATURES) or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
            raise ProcessingFailure("invalid_image", "The image is corrupt or could not be decoded.", status_code=400) from exc
        raise ProcessingFailure("unsupported_image", "Use a JPEG, PNG, or WebP image.", status_code=415) from exc


@dataclass(frozen=True)
class DecodedImage:
    bgr: np.ndarray
    width: int
    height: int
    format: str
    quality_status: str
    warnings: list[str]


def inspect_image(data: bytes, settings: Settings) -> tuple[str, int, int]:
    """Read limits and format from the header before EXIF transpose/RGB expansion."""
    if not data:
        raise ProcessingFailure("empty_file", "The uploaded file is empty.", status_code=400)
    if len(data) > settings.max_upload_bytes:
        raise ProcessingFailure("file_too_large", "The selected image is too large.", status_code=413)
    try:
        with _open(data) as source:
            width, height = source.size
            fmt = (source.format or "").upper()
            if width * height > settings.max_image_pixels:
                raise ProcessingFailure("image_dimensions_too_large", "The image dimensions are too large.", status_code=413)
            if fmt not in SUPPORTED_FORMATS:
                raise ProcessingFailure("unsupported_image", "Use a JPEG, PNG, or WebP image.", status_code=415)
            source.verify()
            return fmt, width, height
    except ProcessingFailure:
        raise
    except Image.DecompressionBombError as exc:
        raise ProcessingFailure("image_dimensions_too_large", "The image dimensions are too large.", status_code=413) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ProcessingFailure("invalid_image", "The image is corrupt or could not be decoded.", status_code=400) from exc


def decode_image(data: bytes, settings: Settings) -> DecodedImage:
    inspect_image(data, settings)
    if not data:
        raise ProcessingFailure("empty_file", "The uploaded file is empty.", status_code=400)
    if len(data) > settings.max_upload_bytes:
        raise ProcessingFailure("file_too_large", "The selected image is too large.", status_code=413)

    try:
        with _open(data) as source:
            source.verify()
        with _open(data) as source:
            image_format = (source.format or "").upper()
            if image_format not in SUPPORTED_FORMATS:
                raise ProcessingFailure(
                    "unsupported_image", "Use a JPEG, PNG, or WebP image.", status_code=415
                )
            image = ImageOps.exif_transpose(source).convert("RGB")
            width, height = image.size
            if width * height > settings.max_image_pixels:
                raise ProcessingFailure(
                    "image_dimensions_too_large", "The decoded image dimensions are too large.", status_code=413
                )
            if min(width, height) < settings.min_image_dimension_px:
                raise ProcessingFailure(
                    "insufficient_resolution",
                    "The image resolution is too low for ruler detection.",
                )
            rgb = np.asarray(image, dtype=np.uint8)
    except ProcessingFailure:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ProcessingFailure("invalid_image", "The image is corrupt or could not be decoded.", status_code=400) from exc

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    underexposed_fraction = float(np.mean(gray <= 5))
    overexposed_fraction = float(np.mean(gray >= 250))
    metrics = (
        f"Quality metrics: focus variance {blur_variance:.1f}, "
        f"underexposed {underexposed_fraction:.3f}, overexposed {overexposed_fraction:.3f}."
    )
    thresholds = (
        settings.blur_variance_min,
        settings.max_underexposed_fraction,
        settings.max_overexposed_fraction,
    )
    if all(value is not None for value in thresholds):
        if blur_variance < settings.blur_variance_min:  # type: ignore[operator]
            raise ProcessingFailure("invalid_image_quality", "The photograph is too blurred. Retake in steady light.")
        if underexposed_fraction > settings.max_underexposed_fraction:  # type: ignore[operator]
            raise ProcessingFailure("invalid_image_quality", "The photograph is too dark. Retake in even light.")
        if overexposed_fraction > settings.max_overexposed_fraction:  # type: ignore[operator]
            raise ProcessingFailure("invalid_image_quality", "The photograph is overexposed or has severe glare.")
        quality_status = "valid"
        warnings = [metrics]
    else:
        quality_status = "not_evaluated"
        warnings = [metrics, "Validated blur, exposure, and glare thresholds have not yet been configured."]

    return DecodedImage(
        bgr=bgr,
        width=width,
        height=height,
        format=image_format,
        quality_status=quality_status,
        warnings=warnings,
    )
