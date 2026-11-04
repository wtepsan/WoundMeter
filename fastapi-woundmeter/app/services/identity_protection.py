"""
Protection of patient identifiers (Thai Citizen ID and contact details).

- Identifiers are encrypted at rest with AES-256-GCM.
- Exact-match lookups use a keyed blind index (HMAC-SHA256), so the raw value is never
  stored in a searchable form and never needs to be logged.
- Only the last four digits are ever returned for display.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import Settings

_NON_DIGITS = re.compile(r"\D")


def normalize_citizen_id(raw: str) -> str:
    return _NON_DIGITS.sub("", raw or "")


def is_valid_thai_citizen_id(raw: str) -> bool:
    """13 digits with the official mod-11 check digit."""
    digits = normalize_citizen_id(raw)
    if len(digits) != 13:
        return False
    total = sum(int(d) * (13 - i) for i, d in enumerate(digits[:12]))
    return (11 - total % 11) % 10 == int(digits[12])


def thai_citizen_id_check_digit(first_twelve: str) -> str:
    total = sum(int(d) * (13 - i) for i, d in enumerate(first_twelve))
    return str((11 - total % 11) % 10)


def normalize_name(raw: str) -> str:
    return " ".join((raw or "").lower().split())


def _derive_key(settings: Settings, purpose: str, configured: Optional[str]) -> bytes:
    if configured:
        try:
            key = base64.b64decode(configured)
            if len(key) == 32:
                return key
        except (ValueError, TypeError):
            pass
        return hashlib.sha256(configured.encode("utf-8")).digest()
    # Demo fallback: deterministic per-purpose key derived from the session secret.
    return hmac.new(settings.session_secret.encode("utf-8"), purpose.encode("utf-8"), hashlib.sha256).digest()


class IdentifierProtector:
    def __init__(self, settings: Settings):
        self.using_configured_keys = bool(settings.patient_data_key and settings.patient_index_key)
        self._enc_key = _derive_key(settings, "woundwise/patient-data/v1", settings.patient_data_key)
        self._index_key = _derive_key(settings, "woundwise/patient-index/v1", settings.patient_index_key)

    def encrypt(self, plaintext: Optional[str]) -> Optional[str]:
        if not plaintext:
            return None
        nonce = os.urandom(12)
        ciphertext = AESGCM(self._enc_key).encrypt(nonce, plaintext.encode("utf-8"), b"woundwise-v1")
        return base64.b64encode(nonce + ciphertext).decode("ascii")

    def decrypt(self, token: Optional[str]) -> Optional[str]:
        if not token:
            return None
        raw = base64.b64decode(token)
        return AESGCM(self._enc_key).decrypt(raw[:12], raw[12:], b"woundwise-v1").decode("utf-8")

    def blind_index(self, kind: str, normalized_value: str) -> str:
        message = f"{kind}:{normalized_value}".encode("utf-8")
        return hmac.new(self._index_key, message, hashlib.sha256).hexdigest()


def mask_identifier(last4: Optional[str]) -> Optional[str]:
    return f"•••••••••{last4}" if last4 else None
