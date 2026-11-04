"""Read-only checks on persisted evidence immediately before a new clinical signature."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from app.services.image_decoder import inspect_image
from app.services.errors import ProcessingFailure
from app.services.measurement_contract import mask_hash


class ImageIntegrityError(ValueError):
    pass


MESSAGE = ("Image provenance verification failed. A required image is missing, changed or inconsistent with its saved evidence. "
           "Preserve the record and investigate or make a new capture; no clinical signature was saved.")


def verify_observation_images(conn, private_storage: Path, observation_id, settings, measurement=None):
    """Never repairs files, recorded hashes or historical approvals.

    Legacy nullable provenance remains readable. Where a mask/colour binding was
    saved, it must still agree with the actual files used by the selected version.
    """
    try:
        observation = conn.execute('SELECT * FROM wound_observations WHERE observation_id=?', (observation_id,)).fetchone()
        if not observation:
            raise ImageIntegrityError(MESSAGE)
        rows = conn.execute('SELECT * FROM wound_images WHERE observation_id=? ORDER BY sequence_id', (observation_id,)).fetchall()
        roles, raw_by_id = {}, {}
        root = private_storage.resolve()
        for row in rows:
            if row['patient_id'] != observation['patient_id'] or row['wound_id'] != observation['wound_id']:
                raise ImageIntegrityError(MESSAGE)
            path = (root / row['storage_key']).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ImageIntegrityError(MESSAGE)
            before = path.stat()
            raw = path.read_bytes()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ImageIntegrityError(MESSAGE)
            if hashlib.sha256(raw).hexdigest() != row['sha256_hash']:
                raise ImageIntegrityError(MESSAGE)
            _, width, height = inspect_image(raw, settings)
            if width != row['width_px'] or height != row['height_px']:
                raise ImageIntegrityError(MESSAGE)
            roles.setdefault(row['image_role'], []).append(row)
            raw_by_id[row['image_id']] = raw
        if len(roles.get('ORIGINAL_UPLOAD', [])) != 1 or len(roles.get('CANONICAL_RECTIFIED', [])) != 1:
            raise ImageIntegrityError(MESSAGE)
        original = roles['ORIGINAL_UPLOAD'][0]
        colour = json.loads(observation['colour_calibration_json'] or 'null')
        if colour:
            if colour.get('source_image_sha256') and colour['source_image_sha256'] != original['sha256_hash']:
                raise ImageIntegrityError(MESSAGE)
            if colour.get('corrected_image_id'):
                matching = next((r for r in roles.get('COLOUR_CORRECTED', []) if r['image_id'] == colour['corrected_image_id']), None)
                if not matching or matching['sha256_hash'] != colour.get('corrected_image_sha256'):
                    raise ImageIntegrityError(MESSAGE)
        if measurement is None:
            mid = observation['final_approved_measurement_id'] or observation['human_corrected_measurement_id'] or observation['provisional_measurement_id']
            found = conn.execute('SELECT * FROM wound_measurements WHERE measurement_id=?', (mid,)).fetchone() if mid else None
            measurement = dict(found) if found else None
        if measurement:
            if (measurement['observation_id'], measurement['patient_id'], measurement['wound_id']) != (
                    observation_id, observation['patient_id'], observation['wound_id']):
                raise ImageIntegrityError(MESSAGE)
            contract = json.loads(measurement.get('geometry_json') or 'null')
            if contract and contract.get('mask_sha256'):
                role = 'HUMAN_CORRECTED_MASK' if measurement['was_human_corrected'] else (
                    'AI_MASK_SAM' if 'sam' in measurement['source_model'].lower() else 'AI_MASK_YOLO')
                candidates = roles.get(role, [])
                if not candidates:
                    raise ImageIntegrityError(MESSAGE)
                # A signed version keeps its original mask binding when later amendment
                # proposals append masks. Every candidate's file hash was verified above.
                masks = [cv2.imdecode(np.frombuffer(raw_by_id[row['image_id']], np.uint8), cv2.IMREAD_GRAYSCALE) for row in candidates]
                if not any(mask is not None and mask_hash(mask) == contract['mask_sha256'] for mask in masks):
                    raise ImageIntegrityError(MESSAGE)
    except ImageIntegrityError:
        raise
    except (OSError, ValueError, TypeError, KeyError, ProcessingFailure) as exc:
        raise ImageIntegrityError(MESSAGE) from exc
