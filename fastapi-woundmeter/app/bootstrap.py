"""Create installation configuration and the first administrator once; in demo mode, add demo accounts."""
import os
from datetime import datetime, timezone
from app.config import settings
from app.services.auth_service import hash_password, validate_new_password
from app.services.demo_accounts import ensure_demo_configuration
from app.services.identity_protection import IdentifierProtector
from app.services.postgres import Connection


def bootstrap_admin(conn):
    if conn.execute('SELECT 1 FROM users LIMIT 1').fetchone(): return
    password = os.environ['BOOTSTRAP_ADMIN_PASSWORD']
    validate_new_password(password)
    secret = os.environ['BOOTSTRAP_ADMIN_TOTP_SECRET']
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("INSERT INTO organizations(org_id,code,name,org_type,active,created_at_utc) VALUES ('ORG-001','WOUNDMETER',?,'HOSPITAL',1,?) ON CONFLICT DO NOTHING", (os.getenv('ORGANIZATION_NAME','WoundMeter'),now))
    conn.execute("INSERT INTO wards(ward_code,name,org_id,active,created_at_utc) VALUES ('WARD01','Ward 01','ORG-001',1,?) ON CONFLICT DO NOTHING", (now,))
    conn.execute("""INSERT INTO users(user_id,subject,username,display_name,role,org_id,wards_json,active,created_at_utc,password_hash,password_changed_at_utc,mfa_enabled,mfa_secret_ciphertext,permissions_json,is_demo_account)
     VALUES ('USR-admin','admin','admin','Administrator','ADMIN','ORG-001','[]',1,?,?,?,1,?,'[]',0)""",
     (now,hash_password(password,settings.password_hash_iterations),now,IdentifierProtector(settings).encrypt(secret)))
    print('Created initial organization, ward and administrator; no patient records.',flush=True)


def bootstrap():
    with Connection() as conn:
        conn.execute('SELECT pg_advisory_xact_lock(4456003)')
        bootstrap_admin(conn)
        if settings.demo_mode:
            created = ensure_demo_configuration(conn)
            print(f"Demo mode on: demo accounts created: {', '.join(created) or 'none (already present)'}; no patient records.", flush=True)

if __name__ == '__main__': bootstrap()
