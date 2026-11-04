"""Apply immutable, checksum-verified PostgreSQL migrations transactionally."""
import hashlib
from pathlib import Path
from app.services.postgres import Connection

def migrate():
    with Connection() as conn:
        conn.execute('SELECT pg_advisory_xact_lock(4456000)')
        conn.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
        for path in sorted((Path(__file__).resolve().parents[1] / 'migrations').glob('*.sql')):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            prior = conn.execute('SELECT sha256 FROM schema_migrations WHERE version=?', (path.name,)).fetchone()
            if prior:
                if prior[0] != digest: raise RuntimeError(f'Applied migration changed: {path.name}')
                continue
            conn.execute(path.read_text())
            conn.execute('INSERT INTO schema_migrations(version,sha256) VALUES (?,?)', (path.name,digest))
            print(f'Applied {path.name}', flush=True)
if __name__ == '__main__': migrate()
