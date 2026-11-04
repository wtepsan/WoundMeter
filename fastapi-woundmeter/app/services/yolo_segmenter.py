from __future__ import annotations

import threading

import hashlib
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.config import Settings

from .errors import ProcessingFailure


@dataclass(frozen=True)
class SegmentationResult:
    masks: list[np.ndarray]
    confidences: list[float]
    inference_time_ms: float
    model_version: str
    model_checksum: str


class YoloSegmenter:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._model_checksum: str | None = None
        # One shared model instance: loading and inference are serialised (Ultralytics models are
        # not safe for concurrent predict). The real workflow already serialises; /demo runs in parallel.
        self._lock = threading.RLock()

    def _load(self):
        with self._lock:
            return self._load_locked()

    def _load_locked(self):
        if self._model is not None:
            return self._model
        try:
            import torch
            from ultralytics import YOLO
        except ImportError as exc:
            raise ProcessingFailure(
                "backend_not_ready", "The wound segmentation model dependencies are unavailable.", status_code=503
            ) from exc
        if not self.settings.model_path.is_file():
            raise ProcessingFailure(
                "backend_not_ready", "The wound segmentation model is unavailable.", status_code=503
            )
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model = YOLO(str(self.settings.model_path)).to(device)
        self._model_checksum = _sha256(self.settings.model_path)
        return self._model

    @property
    def ready(self) -> bool:
        return self.settings.model_path.is_file()

    def segment(self, inner_bgr: np.ndarray) -> SegmentationResult:
        model = self._load()
        import torch

        started = time.perf_counter()
        with self._lock, torch.inference_mode():
            results = model.predict(
                inner_bgr,
                imgsz=self.settings.yolo_image_size,
                conf=self.settings.yolo_confidence,
                verbose=False,
                retina_masks=True,
            )
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        result = results[0]
        if result.masks is None or result.masks.data is None:
            masks: list[np.ndarray] = []
        else:
            raw = result.masks.data.detach().cpu().numpy()
            if raw.ndim == 2:
                raw = raw[None, ...]
            height, width = inner_bgr.shape[:2]
            masks = [
                (
                    cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                    >= self.settings.mask_threshold
                ).astype(np.uint8)
                for mask in raw
            ]
        if getattr(result, "boxes", None) is not None and result.boxes.conf is not None:
            confidences = [float(value) for value in result.boxes.conf.detach().cpu().tolist()]
        else:
            confidences = []
        return SegmentationResult(
            masks=masks,
            confidences=confidences,
            inference_time_ms=elapsed_ms,
            model_version=self.settings.model_path.stem,
            model_checksum=self._model_checksum or _sha256(self.settings.model_path),
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
