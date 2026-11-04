#!/usr/bin/env python3
"""Generate new installation secrets locally; refuses to overwrite .env."""
import base64, os, secrets
from pathlib import Path
root = Path(__file__).resolve().parents[1]
values = {
 'POSTGRES_PASSWORD': secrets.token_hex(32),
 'SESSION_SECRET': secrets.token_hex(48),
 'PATIENT_DATA_KEY': base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
 'PATIENT_INDEX_KEY': secrets.token_hex(32),
 'BOOTSTRAP_ADMIN_PASSWORD': secrets.token_urlsafe(24),
 'BOOTSTRAP_ADMIN_TOTP_SECRET': base64.b32encode(secrets.token_bytes(20)).decode(),
 'ORGANIZATION_NAME': 'WoundMeter', 'CLINICAL_TIMEZONE':'Asia/Bangkok',
 'META_AI_ENABLED':'false', 'META_API_KEY':'',
}
fd=os.open(root/'.env', os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream:
 for key,value in values.items(): stream.write(f'{key}={value}\n')
print('Created mode-0600 .env. Retrieve administrator credentials privately on this host.')
