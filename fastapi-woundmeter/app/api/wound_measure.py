from __future__ import annotations
import hashlib
import logging
import os
from typing import Optional
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse
from app.config import settings
from app.services.errors import TemplateConfigurationError
from app.services.meta_client import MetaModelClient
from app.services.pipeline import MeasurementPipeline
from app.services.ruler_template import load_ruler_template
from app.services.yolo_segmenter import YoloSegmenter
system_router = APIRouter()
logger = logging.getLogger(__name__)
template_error = None
pipeline = None
meta_client = MetaModelClient(settings)
try:
    ruler_template = load_ruler_template(settings.ruler_template_path)
    pipeline = MeasurementPipeline(settings, ruler_template, YoloSegmenter(settings), meta_client)
except (OSError, TemplateConfigurationError) as exc:
    template_error = str(exc)
def _response(payload, status_code):
    return JSONResponse(content=payload, status_code=status_code, headers={"Cache-Control": "no-store"})

@system_router.get("/v2/meta/status", tags=["system"])
async def get_meta_status(x_reviewer_token: Optional[str] = Header(default=None)):
    from app.api import connected_care
    from app.services.auth_service import AuthService
    from app.services.admin_service import AdminService
    from app.services.connected_care_db import AccessDeniedError

    try:
        AdminService.require_admin(AuthService(connected_care.care_service).resolve(x_reviewer_token))
    except AccessDeniedError as exc:
        return _response(
            {"code": exc.code, "message": exc.message},
            401 if exc.code == "AUTHENTICATION_REQUIRED" else 403,
        )
    return _response(
        {
            "meta_ai_enabled": settings.meta_ai_enabled,
            "meta_api_configured": settings.meta_configured,
            "meta_api_base_url": settings.meta_api_base_url,
            "segmentation_model": settings.meta_segmentation_model,
            "reasoning_model": settings.meta_reasoning_model,
            "usage": meta_client.usage.snapshot(),
        },
        200,
    )


@system_router.get("/v2/health", tags=["system"])
async def v2_health():
    # Ready means local measurement and storage can work. Remote Meta reachability is not probed;
    # submissions fall back to labelled local segmentation when it is unavailable.
    from app.api.connected_care import care_service
    database_connected = False
    try:
        with care_service._connect() as conn:
            conn.execute("SELECT patient_id FROM patients LIMIT 1").fetchall()
        database_connected = True
    except Exception:
        logger.exception("Configured database health check failed")
    checks = {
        "database_connected": database_connected,
        "template_configured": pipeline is not None,
        "local_model_present": settings.model_path.is_file(),
        "results_dir_writable": os.access(settings.results_dir, os.W_OK),
    }
    ready = all(checks.values())
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "status": "ready" if ready else "not_ready",
            "database_location_id": hashlib.sha256(str(care_service.db_path).encode()).hexdigest(),
            **checks,
            "template_error": template_error,
            "meta_ai_enabled": settings.meta_ai_enabled,
            "meta_api_configured": settings.meta_configured,
            "meta_reachability": "not_probed",
            "segmentation_models": {
                "yolo": settings.model_path.stem if settings.model_path.is_file() else "missing",
                "sam": settings.meta_segmentation_model if settings.meta_configured else "disabled",
            },
            "reasoning_model": settings.meta_reasoning_model if settings.meta_configured else "disabled",
        },
        headers={"Cache-Control": "no-store"},
    )
