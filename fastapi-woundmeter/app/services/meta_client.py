from __future__ import annotations

import base64
import json
import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import cv2
import httpx
import numpy as np

from app.config import Settings
from app.schemas.response import MuseExplanationResponse

from .sam_codec import (
    ParsedSamCandidate,
    build_sam_multi_object_prompt,
    build_sam_object_prompt,
    parse_sam_response_text,
)


logger = logging.getLogger(__name__)

# Unqualified noun phrase: an attribute such as "red" would restrict SAM to that subset of the
# wound (Meta SAM 3.1 segmenting guide), which excluded yellow slough in the worsening phantoms.
DEFAULT_SAM_CONCEPT = "wound"
LEGACY_SAM_CONCEPT = "red wound"  # kept only to reproduce the earlier behaviour in benchmarks


class MetaApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class MetaUsageStats:
    sam_requests_total: int = 0
    sam_requests_succeeded: int = 0
    sam_requests_failed: int = 0
    sam_images_processed: int = 0
    sam_total_latency_ms: float = 0.0
    muse_requests_total: int = 0
    muse_requests_succeeded: int = 0
    muse_requests_failed: int = 0
    muse_prompt_tokens: int = 0
    muse_completion_tokens: int = 0
    muse_total_latency_ms: float = 0.0
    rate_limit_retries: int = 0
    estimated_cost_usd: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_sam(self, *, success: bool, latency_ms: float, images: int = 1) -> None:
        with self._lock:
            self.sam_requests_total += 1
            self.sam_total_latency_ms += latency_ms
            if success:
                self.sam_requests_succeeded += 1
                self.sam_images_processed += images
                # Estimated $0.0015 per image for SAM 3.1 API
                self.estimated_cost_usd += 0.0015 * images
            else:
                self.sam_requests_failed += 1

    def record_muse(
        self,
        *,
        success: bool,
        latency_ms: float,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> None:
        with self._lock:
            self.muse_requests_total += 1
            self.muse_total_latency_ms += latency_ms
            if success:
                self.muse_requests_succeeded += 1
                self.muse_prompt_tokens += prompt_tokens
                self.muse_completion_tokens += completion_tokens
                # Estimated token pricing
                self.estimated_cost_usd += (prompt_tokens * 0.000001) + (completion_tokens * 0.000003)
            else:
                self.muse_requests_failed += 1

    def record_retry(self) -> None:
        with self._lock:
            self.rate_limit_retries += 1

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "sam_requests_total": self.sam_requests_total,
                "sam_requests_succeeded": self.sam_requests_succeeded,
                "sam_requests_failed": self.sam_requests_failed,
                "sam_images_processed": self.sam_images_processed,
                "sam_mean_latency_ms": round(
                    self.sam_total_latency_ms / self.sam_requests_total, 2
                )
                if self.sam_requests_total
                else 0.0,
                "muse_requests_total": self.muse_requests_total,
                "muse_requests_succeeded": self.muse_requests_succeeded,
                "muse_requests_failed": self.muse_requests_failed,
                "muse_prompt_tokens": self.muse_prompt_tokens,
                "muse_completion_tokens": self.muse_completion_tokens,
                "muse_mean_latency_ms": round(
                    self.muse_total_latency_ms / self.muse_requests_total, 2
                )
                if self.muse_requests_total
                else 0.0,
                "rate_limit_retries": self.rate_limit_retries,
                "cost_estimate_status": "unavailable_unverified_pricing",
            }


MUSE_EXPLANATION_JSON_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "measurement_summary": {
            "type": "string",
            "description": "Concise clinical-grade summary of area, length, width, and perimeter from the deterministic backend values.",
        },
        "segmentation_explanation": {
            "type": "string",
            "description": "Explanation of the segmentation method used (YOLO, Meta SAM 3.1, or comparison) and any observed inter-model agreement or human refinement.",
        },
        "measurement_limitations": {
            "type": "string",
            "description": "Explanation of 2D projective limitations, calibration status, and any image-quality warnings.",
        },
        "historical_comparison": {
            "type": "string",
            "description": "Deterministic numerical comparison with previous measurements if present, explicitly noting that numerical change alone does not establish healing or deterioration.",
        },
        "documentation_draft": {
            "type": "string",
            "description": "Concise proposed documentation draft for medical staff to review, edit, or discard.",
        },
        "questions_for_reviewer": {
            "type": "array",
            "items": {"type": "string"},
            "description": "2 to 4 neutral questions highlighting clinical observations the medical professional should verify on bedside inspection.",
        },
    },
    "required": [
        "measurement_summary",
        "segmentation_explanation",
        "measurement_limitations",
        "historical_comparison",
        "documentation_draft",
        "questions_for_reviewer",
    ],
    "additionalProperties": False,
}

MUSE_SYSTEM_PROMPT = (
    "You are Muse Spark, an explainable AI assistant embedded in WoundMeter, a human-in-the-loop "
    "wound measurement research prototype. Your role is strictly to explain deterministic physical "
    "measurements, calibration status, and segmentation agreement to qualified medical staff.\n\n"
    "NON-NEGOTIABLE SAFETY RULES:\n"
    "1. NEVER diagnose wounds, infection, tissue type, or pressure injury stages.\n"
    "2. NEVER prescribe or recommend treatments, dressings, or medications.\n"
    "3. NEVER conclude autonomously that a wound is clinically healing or deteriorating; state only "
    "the numerical change and note that clinical interpretation belongs to medical staff.\n"
    "4. NEVER invent or alter numerical measurements. Cite only the exact area_cm2, length_cm, width_cm, "
    "and perimeter_cm provided in the structured input.\n"
    "5. Frame all documentation drafts as provisional wording requiring medical professional review."
)


class MetaModelClient:
    """Secure server-side adapter for Meta Model API (SAM 3.1 and Muse Spark 1.3)."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.usage = MetaUsageStats()
        self._semaphore = threading.BoundedSemaphore(max(1, settings.meta_max_concurrency))

    @property
    def is_enabled(self) -> bool:
        return self.settings.meta_configured

    def _headers(self) -> Dict[str, str]:
        if not self.settings.meta_api_key:
            raise MetaApiError("meta_key_missing", "Meta Model API key is not configured.", 503)
        return {
            "Authorization": f"Bearer {self.settings.meta_api_key}",
            "Content-Type": "application/json",
        }

    def _post_with_retry(self, endpoint: str, payload: Dict[str, Any], *, deadline: Optional[float] = None,
                         long_running: bool = False) -> Dict[str, Any]:
        # One shared elapsed-time budget includes queueing, retries and SAM prompt fallback.
        deadline = deadline if deadline is not None else time.monotonic() + min(20.0, max(.1, self.settings.meta_timeout_seconds))
        url = f"{self.settings.meta_api_base_url}/{endpoint.lstrip('/')}"
        headers = self._headers()
        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise MetaApiError("meta_api_timeout", "Meta request budget expired; use the available fallback or retry later.", 504)
            return value
        if not self._semaphore.acquire(timeout=remaining()):
            raise MetaApiError("meta_api_timeout", "Meta request queue exceeded its time budget.", 504)
        try:
            for attempt in range(2):
                delay = 1.0
                try:
                    # HTTPX timeouts are per I/O phase. Check elapsed time between streamed
                    # chunks too; a trickling response must not keep retries alive forever.
                    # A non-streamed Muse completion sends nothing until it is done, so its read
                    # phase may use most of the remaining budget; SAM keeps short phases.
                    phase_timeout = remaining() * 0.9 if long_running else min(self.settings.meta_timeout_seconds, remaining() / 4)
                    with httpx.Client(timeout=phase_timeout) as client:
                        with client.stream("POST", url, headers=headers, json=payload) as response:
                            chunks, total = [], 0
                            for chunk in response.iter_bytes():
                                remaining()
                                total += len(chunk)
                                if total > 16 * 1024 * 1024:
                                    raise MetaApiError("meta_response_too_large", "Meta response exceeded its size limit.", 502)
                                chunks.append(chunk)
                            remaining()
                            if response.status_code == 429 and attempt == 0:
                                try:
                                    delay = float(response.headers.get("Retry-After", "1"))
                                    delay = min(4.0, max(0.0, delay)) if math.isfinite(delay) else 1.0
                                except ValueError:
                                    delay = 1.0
                            elif response.status_code >= 400:
                                raise MetaApiError(f"meta_http_{response.status_code}", f"Meta Model API returned HTTP {response.status_code}.", response.status_code)
                            else:
                                try:
                                    body = json.loads(b"".join(chunks))
                                    if not isinstance(body, dict):
                                        raise ValueError("Expected an object")
                                    return body
                                except ValueError as exc:
                                    raise MetaApiError("meta_invalid_json", "Meta Model API returned an invalid JSON object.", 502) from exc
                except httpx.TimeoutException as exc:
                    if attempt == 1:
                        raise MetaApiError("meta_api_timeout", "Meta request timed out; fallback remains available.", 504) from exc
                except httpx.RequestError as exc:
                    raise MetaApiError("meta_api_unreachable", "Could not reach Meta Model API endpoint.", 503) from exc
                if delay >= remaining():
                    raise MetaApiError("meta_api_timeout", "No time remains for another Meta attempt.", 504)
                self.usage.record_retry()
                time.sleep(delay)
        finally:
            self._semaphore.release()
        raise MetaApiError("meta_request_failed", "Meta Model API request failed.", 502)

    def sam_deadline(self) -> float:
        """One elapsed-time budget for every SAM call made for a single photograph."""
        return time.monotonic() + min(20.0, max(.1, self.settings.meta_timeout_seconds))

    def segment_with_sam(
        self,
        inner_bgr: np.ndarray,
        *,
        text_prompt: str = DEFAULT_SAM_CONCEPT,
        box_xyxy: Optional[Tuple[int, int, int, int]] = None,
        points: Optional[List[Dict[str, int | str]]] = None,
        objects: Optional[List[Dict[str, Any]]] = None,
        deadline: Optional[float] = None,
    ) -> Tuple[List[ParsedSamCandidate], float, str]:
        """Run Meta SAM 3.1 segmentation on the privacy-safe inner ruler crop.

        Concept mode sends one short noun phrase. Meta documents that attributes narrow a concept
        ("red square" matches a subset of "square"), so the default is the unqualified noun and no
        attribute-narrowed prompt is ever tried as a fallback. Spatial mode (`box_xyxy`/`points` or
        `objects`) is a separate prompt mode and never carries a noun phrase.
        """
        if not self.is_enabled:
            raise MetaApiError(
                "meta_disabled",
                "Meta SAM 3.1 is disabled or META_API_KEY is not configured.",
                503,
            )

        height, width = inner_bgr.shape[:2]
        # Re-encode clean JPEG buffer to strip any metadata/EXIF before API transmission
        ok, encoded = cv2.imencode(".jpg", inner_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise MetaApiError("image_encode_error", "Could not encode inner crop for SAM 3.1.", 500)
        b64_image = base64.b64encode(encoded.tobytes()).decode("ascii")

        if objects:
            prompt_str = build_sam_multi_object_prompt(width, height, objects)
            prompt_description = f"spatial:{prompt_str}"
        elif box_xyxy is not None or points:
            prompt_str = build_sam_object_prompt(
                width,
                height,
                box=box_xyxy,
                points=points,
                object_id=0,
            )
            prompt_description = f"spatial:{prompt_str}"
        else:
            prompt_str = (text_prompt or DEFAULT_SAM_CONCEPT).strip()[:80]
            prompt_description = f"text:{prompt_str}"

        payload: Dict[str, Any] = {
            "model": self.settings.meta_segmentation_model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt_str},
                        {
                            "type": "input_image",
                            "image_url": f"data:image/jpeg;base64,{b64_image}",
                        },
                    ],
                }
            ],
            "metadata": {"include_confidence": "true"},
        }

        started = time.perf_counter()
        deadline = deadline if deadline is not None else self.sam_deadline()
        try:
            body = self._post_with_retry("/responses", payload, deadline=deadline)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            output_texts: List[str] = []
            for item in body.get("output", []):
                if not isinstance(item, dict):
                    continue
                for content_block in item.get("content", []):
                    if isinstance(content_block, dict) and content_block.get("type") == "output_text":
                        output_texts.append(str(content_block.get("text", "")))
            candidates = parse_sam_response_text("\n".join(output_texts), width, height)
            if not candidates:
                raise MetaApiError("meta_no_valid_mask", "Meta returned no usable mask; local fallback or recapture is required.", 502)
            self.usage.record_sam(success=True, latency_ms=elapsed_ms)
            return candidates, elapsed_ms, prompt_description
        except Exception:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.usage.record_sam(success=False, latency_ms=elapsed_ms)
            raise

    def explain_measurements_with_muse(
        self,
        structured_context: Dict[str, Any],
    ) -> MuseExplanationResponse:
        """Generate structured explainable AI commentary using Meta Muse Spark 1.3."""
        if not self.is_enabled:
            return self.deterministic_fallback_explanation(
                structured_context,
                reason="Meta AI is disabled or META_API_KEY is not configured.",
            )

        payload: Dict[str, Any] = {
            "model": self.settings.meta_reasoning_model,
            "messages": [
                {"role": "system", "content": MUSE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "Provide a structured explanation for the following validated wound measurement "
                        "telemetry (all numbers are server-calculated and must not be altered):\n"
                        + json.dumps(structured_context, ensure_ascii=False)
                    ),
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "wound_explanation",
                    "strict": True,
                    "schema": MUSE_EXPLANATION_JSON_SCHEMA,
                },
            },
        }

        if self.settings.meta_reasoning_effort:
            payload["reasoning_effort"] = self.settings.meta_reasoning_effort
        started = time.perf_counter()
        try:
            # A Muse completion sends nothing until done: use the reasoning budget, as muse_chat does.
            body = self._post_with_retry("/chat/completions", payload, deadline=self.reasoning_deadline(), long_running=True)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            usage_info = body.get("usage") or {}
            prompt_tokens = int(usage_info.get("prompt_tokens") or 0)
            completion_tokens = int(usage_info.get("completion_tokens") or 0)

            choices = body.get("choices") or []
            if not choices:
                raise MetaApiError("muse_empty_response", "Muse Spark returned no choices.")
            raw_content = choices[0].get("message", {}).get("content", "{}")
            parsed = json.loads(raw_content)

            self.usage.record_muse(
                success=True,
                latency_ms=elapsed_ms,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )

            return MuseExplanationResponse(
                status="ready",
                model_id=self.settings.meta_reasoning_model,
                disclaimer="AI-generated draft — requires medical professional review.",
                measurement_summary=str(parsed.get("measurement_summary", "")).strip(),
                segmentation_explanation=str(parsed.get("segmentation_explanation", "")).strip(),
                measurement_limitations=str(parsed.get("measurement_limitations", "")).strip(),
                historical_comparison=str(parsed.get("historical_comparison", "")).strip(),
                documentation_draft=str(parsed.get("documentation_draft", "")).strip(),
                questions_for_reviewer=[
                    str(q).strip() for q in (parsed.get("questions_for_reviewer") or []) if str(q).strip()
                ][:5],
                latency_ms=round(elapsed_ms, 2),
            )
        except Exception as exc:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.usage.record_muse(success=False, latency_ms=elapsed_ms)
            logger.warning("Muse Spark explanation unavailable (%s); using deterministic summary.", exc)
            return self.deterministic_fallback_explanation(
                structured_context,
                reason=str(exc),
                latency_ms=round(elapsed_ms, 2),
            )

    def reasoning_deadline(self) -> float:
        return time.monotonic() + max(1.0, self.settings.meta_reasoning_timeout_seconds)

    def muse_chat(
        self,
        messages: List[Dict[str, Any]],
        *,
        response_schema: Optional[Dict[str, Any]] = None,
        schema_name: str = "response",
        tools: Optional[List[Dict[str, Any]]] = None,
        deadline: Optional[float] = None,
        reasoning_effort: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], float]:
        """One Muse Spark 1.3 chat completion (structured output and/or tools). Returns (message, latency_ms).

        Request format per the Meta Model API docs: images as `image_url` parts in user messages,
        `response_format: json_schema`, tools with `tool_choice: "auto"` (the only supported value).
        Never fabricates output: every failure raises MetaApiError for the caller to report.
        """
        if not self.is_enabled:
            raise MetaApiError("meta_disabled", "Meta Muse Spark is disabled or META_API_KEY is not configured.", 503)
        payload: Dict[str, Any] = {"model": self.settings.meta_reasoning_model, "messages": messages}
        effort = reasoning_effort or self.settings.meta_reasoning_effort
        if effort:
            payload["reasoning_effort"] = effort
        if response_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "schema": response_schema, "strict": True},
            }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        started = time.perf_counter()
        try:
            body = self._post_with_retry("/chat/completions", payload,
                                         deadline=deadline or self.reasoning_deadline(), long_running=True)
            choices = body.get("choices") or []
            if not choices or not isinstance(choices[0].get("message"), dict):
                raise MetaApiError("muse_empty_response", "Muse Spark returned no message.", 502)
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            usage_info = body.get("usage") or {}
            self.usage.record_muse(success=True, latency_ms=elapsed_ms,
                                   prompt_tokens=int(usage_info.get("prompt_tokens") or 0),
                                   completion_tokens=int(usage_info.get("completion_tokens") or 0))
            return choices[0]["message"], elapsed_ms
        except Exception:
            self.usage.record_muse(success=False, latency_ms=(time.perf_counter() - started) * 1000.0)
            raise

    def muse_structured(self, messages: List[Dict[str, Any]], schema: Dict[str, Any], name: str,
                        deadline: Optional[float] = None, reasoning_effort: Optional[str] = None) -> Tuple[Dict[str, Any], float]:
        message, elapsed_ms = self.muse_chat(messages, response_schema=schema, schema_name=name, deadline=deadline,
                                             reasoning_effort=reasoning_effort)
        try:
            parsed = json.loads(message.get("content") or "")
        except (TypeError, ValueError) as exc:
            raise MetaApiError("muse_invalid_json", "Muse Spark returned text that is not the requested JSON.", 502) from exc
        if not isinstance(parsed, dict):
            raise MetaApiError("muse_invalid_json", "Muse Spark returned JSON that is not an object.", 502)
        return parsed, elapsed_ms

    def transcribe_audio(
        self,
        wav_bytes: bytes,
        *,
        language_bias: Optional[List[str]] = None,
        keywords: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Muse Voice Transcribe 1.0 through `POST /v1/asr/transcribe` (multipart, push-to-talk WAV).

        The audio is sent once and never stored by WoundMeter. Returns {transcript, audio_duration_ms,
        session_id, latency_ms, model}.
        """
        if not self.is_enabled:
            raise MetaApiError("meta_disabled", "Meta voice transcription is disabled or META_API_KEY is not configured.", 503)
        request: Dict[str, Any] = {"model": self.settings.meta_transcription_model, "audioEncoding": "WAV",
                                   "mode": "PUSH_TO_TALK"}
        if language_bias:
            request["languageBias"] = language_bias
        if keywords:
            request["keywords"] = keywords
        url = f"{self.settings.meta_api_base_url}/asr/transcribe"
        headers = {"Authorization": f"Bearer {self.settings.meta_api_key}", "Accept": "application/json"}
        files = {
            "request": (None, json.dumps(request), "application/json"),
            "audio": ("recording.wav", wav_bytes, "audio/wav"),
        }
        started = time.perf_counter()
        timeout = max(5.0, self.settings.meta_reasoning_timeout_seconds)
        if not self._semaphore.acquire(timeout=timeout):
            raise MetaApiError("meta_api_timeout", "Meta request queue exceeded its time budget.", 504)
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, headers=headers, files=files)
            if response.status_code >= 400:
                raise MetaApiError(f"meta_http_{response.status_code}",
                                   f"Meta voice transcription returned HTTP {response.status_code}.", response.status_code)
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("transcript"), str):
                raise MetaApiError("meta_invalid_json", "Meta voice transcription returned no transcript.", 502)
        except httpx.TimeoutException as exc:
            raise MetaApiError("meta_api_timeout", "Meta voice transcription timed out.", 504) from exc
        except httpx.RequestError as exc:
            raise MetaApiError("meta_api_unreachable", "Could not reach the Meta voice transcription endpoint.", 503) from exc
        except ValueError as exc:
            raise MetaApiError("meta_invalid_json", "Meta voice transcription returned invalid JSON.", 502) from exc
        finally:
            self._semaphore.release()
        return {
            "transcript": body["transcript"].strip(),
            "audio_duration_ms": body.get("audioDurationMs"),
            "session_id": body.get("sessionId"),
            "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
            "model": self.settings.meta_transcription_model,
        }

    @staticmethod
    def deterministic_fallback_explanation(
        structured_context: Dict[str, Any],
        *,
        reason: Optional[str] = None,
        latency_ms: Optional[float] = None,
    ) -> MuseExplanationResponse:
        """Deterministic explanation when Muse Spark is offline or disabled (never fabricates LLM output)."""
        area = structured_context.get("area_cm2")
        length = structured_context.get("length_cm")
        width = structured_context.get("width_cm")
        perim = structured_context.get("perimeter_cm")
        seg_model = structured_context.get("segmentation_model", "YOLO")
        cal_status = structured_context.get("calibration_status", "unknown")
        rev_status = structured_context.get("human_review_status", "pending")
        warnings = structured_context.get("quality_warnings") or []
        comparison = structured_context.get("model_comparison") or {}
        history = structured_context.get("historical_delta")

        if area is not None and length is not None and width is not None:
            perim_text = f", and outer contour perimeter of {perim:.2f} cm" if perim is not None else ""
            meas_summary = (
                f"Calibrated 2D surface area is {area:.2f} cm², with a maximum vertical chord length of "
                f"{length:.2f} cm, maximum horizontal chord width of {width:.2f} cm{perim_text}. "
                f"Current review status is {rev_status}."
            )
            doc_draft = (
                f"Provisional 2D optical wound measurement ({seg_model}, calibration: {cal_status}): "
                f"Area {area:.2f} cm², vertical length {length:.2f} cm, horizontal width {width:.2f} cm"
                f"{f', perimeter {perim:.2f} cm' if perim is not None else ''}. "
                "Boundary and clinical characteristics require verification by the examining clinician."
            )
        else:
            meas_summary = "No authoritative physical dimensions are available for this session."
            doc_draft = "Optical wound measurement pending valid calibration and clinician boundary review."

        dice = comparison.get("dice_coefficient")
        if dice is not None:
            seg_expl = (
                f"Active segmentation source: {seg_model}. Inter-model comparison between YOLO and "
                f"Meta SAM 3.1 yielded a Dice similarity coefficient of {dice:.3f} "
                f"(IoU {comparison.get('iou', 0.0):.3f}). Agreement reflects model consistency, not clinical truth."
            )
        else:
            seg_expl = (
                f"Segmentation generated by {seg_model} on the rectified inner ruler crop and mapped "
                "to canonical ruler coordinates. Requires human boundary verification."
            )

        warn_str = " ".join(warnings) if warnings else "No additional image-quality warnings recorded."
        lim_text = (
            f"Calibration status: {cal_status}. Measurements represent a flat 2D planar projection "
            f"and do not capture wound depth, undermining, sinus tracts, or tissue viability. {warn_str}"
        )

        if isinstance(history, dict) and history.get("previous_area_cm2") is not None:
            prev_a = history["previous_area_cm2"]
            delta_a = history.get("area_change_cm2", 0.0)
            pct_a = history.get("area_change_pct", 0.0)
            direction = "decreased" if delta_a < 0 else ("increased" if delta_a > 0 else "remained unchanged")
            hist_text = (
                f"Compared with the previous recorded measurement ({prev_a:.2f} cm²), the measured 2D area "
                f"{direction} by {abs(delta_a):.2f} cm² ({abs(pct_a):.1f}%). This is a numerical observation "
                "and does not by itself establish clinical healing or deterioration."
            )
        else:
            hist_text = (
                "No prior verified measurement was linked for longitudinal comparison in this request. "
                "Once confirmed by a clinician, this measurement can serve as a reference point."
            )

        return MuseExplanationResponse(
            status="fallback_deterministic",
            model_id="deterministic-template-v1",
            disclaimer="AI-generated draft — requires medical professional review.",
            measurement_summary=meas_summary,
            segmentation_explanation=seg_expl,
            measurement_limitations=lim_text,
            historical_comparison=hist_text,
            documentation_draft=doc_draft,
            questions_for_reviewer=[
                "Does the proposed segmentation boundary accurately trace the true clinical wound edge?",
                "Are there undermining, tunneling, or depth components not visible in this 2D photograph?",
                "What are the bedside findings for wound-bed tissue composition, exudate, and surrounding skin?",
                "Are there any clinical signs of infection or uncontrolled pain requiring escalation?",
            ],
            latency_ms=latency_ms,
            error_message=reason,
        )
