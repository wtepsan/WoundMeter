from app.config import settings
from app.services.database_storage import validate_deployment_storage

# Validate existing storage before pipeline imports create any runtime directories.
validate_deployment_storage(settings)
from app.services.request_limits import RequestBodyLimit
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.admin import router as admin_router
from app.api.auth import router as auth_router
from app.api.clinical_ai import router as clinical_ai_router
from app.api.connected_care import router as connected_care_router
from app.api.demo_measure import router as demo_measure_router
from app.api.nursing import router as nursing_router
from app.api.wound_measure import system_router


app = FastAPI(title="WoundMeter API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4456", "http://127.0.0.1:4456"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(RequestBodyLimit, max_bytes=4 * ((settings.max_upload_bytes + 2) // 3) + 65536)
# The submitted application uses patient-scoped connected-care processing. The
# standalone studio has no patient ownership model and must not be exposed here.
app.include_router(system_router)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(connected_care_router)
app.include_router(nursing_router)
app.include_router(clinical_ai_router)
app.include_router(demo_measure_router)
