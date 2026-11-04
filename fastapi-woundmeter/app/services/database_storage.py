"""PostgreSQL schema and encryption preflight; never imports historical data."""
import json
from pathlib import Path
from app.services.postgres import Connection

class DatabaseStorageError(RuntimeError):
    pass

def storage_root(value):
    path = Path(value).expanduser()
    if not path.is_absolute() or path == Path(path.anchor):
        raise DatabaseStorageError("RESULTS_DIR must be an absolute non-root directory.")
    return path.resolve()

def validate_schema(conn, group):
    contract = json.loads((Path(__file__).resolve().parents[2] / "config/database_schema_v1.json").read_text())
    for table, columns in contract[group].items():
        present = {r[0] for r in conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?", (table,))}
        if not set(columns) <= present:
            raise DatabaseStorageError(f"Schema mismatch for {table}; run the versioned migrations.")

def validate_encryption_context(conn, protector):
    """Catch selecting an existing store with unrelated keys, without re-encrypting it."""
    try:
        for table, field in (("users", "mfa_secret_ciphertext"), ("patients", "national_id_ciphertext"),
                             ("patients", "contact_phone_ciphertext")):
            row = conn.execute(f'SELECT "{field}" FROM "{table}" WHERE "{field}" IS NOT NULL AND "{field}" != \'\' LIMIT 1').fetchone()
            if row:
                protector.decrypt(row[0])
        row = conn.execute("SELECT national_id_ciphertext,national_id_blind_index FROM patients WHERE national_id_ciphertext IS NOT NULL AND national_id_blind_index IS NOT NULL LIMIT 1").fetchone()
        if row and protector.blind_index("THAI_CITIZEN_ID", protector.decrypt(row[0])) != row[1]:
            raise ValueError("Blind-index key mismatch")
    except Exception as exc:
        raise DatabaseStorageError(
            "Configured encryption keys do not match existing identifiers or MFA data. "
            "Restore the matching SESSION_SECRET / PATIENT_DATA_KEY / PATIENT_INDEX_KEY; no records were changed."
        ) from exc


def validate_deployment_storage(settings):
    from app.services.identity_protection import IdentifierProtector
    root = storage_root(settings.results_dir)
    if not (root / "private_storage").is_dir():
        raise DatabaseStorageError("Private upload storage is missing.")
    with Connection() as conn:
        validate_schema(conn, "care")
        validate_schema(conn, "nursing")
        validate_encryption_context(conn, IdentifierProtector(settings))

def inspect_storage(value):
    """Read-only schema, referential integrity and private-image checksum diagnostics."""
    import hashlib
    from psycopg import sql
    private = storage_root(value) / 'private_storage'
    missing = unsafe = mismatches = violations = 0
    with Connection() as conn:
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        validate_schema(conn, 'care')
        validate_schema(conn, 'nursing')
        tables = [r[0] for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")]
        counts = {table: conn.raw.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone()[0] for table in tables}
        constraints = conn.execute("""SELECT s.relname AS source, t.relname AS target,
            ARRAY(SELECT attname FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
                  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS source_columns,
            ARRAY(SELECT attname FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
                  JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
            FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid
            JOIN pg_namespace n ON n.oid=s.relnamespace WHERE c.contype='f' AND n.nspname='public'""").fetchall()
        for fk in constraints:
            nonnull = sql.SQL(' AND ').join(sql.SQL('s.{} IS NOT NULL').format(sql.Identifier(col)) for col in fk['source_columns'])
            match = sql.SQL(' AND ').join(sql.SQL('s.{}=t.{}').format(sql.Identifier(a),sql.Identifier(b)) for a,b in zip(fk['source_columns'],fk['target_columns']))
            query = sql.SQL('SELECT count(*) FROM {} s WHERE {} AND NOT EXISTS (SELECT 1 FROM {} t WHERE {})').format(sql.Identifier(fk['source']),nonnull,sql.Identifier(fk['target']),match)
            violations += conn.raw.execute(query).fetchone()[0]
        images = conn.execute('SELECT storage_key,sha256_hash FROM wound_images').fetchall()
        for row in images:
            path = (private / row['storage_key']).resolve()
            if not path.is_relative_to(private.resolve()):
                unsafe += 1
                continue
            if not path.is_file():
                missing += 1
                continue
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024*1024), b''): digest.update(chunk)
            mismatches += int(digest.hexdigest() != row['sha256_hash'])
        database = conn.execute('SELECT current_database()').fetchone()[0]
    return {'database_path': f'postgresql://postgres:5432/{database}', 'private_storage_path': str(private),
            'table_counts': counts, 'integrity_check': ['ok'], 'foreign_key_violations': violations,
            'image_references': len(images), 'missing_images': missing, 'unsafe_image_paths': unsafe,
            'image_hash_mismatches': mismatches}
