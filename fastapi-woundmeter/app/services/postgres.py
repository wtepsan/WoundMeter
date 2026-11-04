"""PostgreSQL transactions with named/positional rows and bound qmark parameters.

The service layer uses DB-API qmark SQL. Only placeholders are translated; all
values remain psycopg-bound parameters. No SQLite database is opened or created.
"""
import os
import re
from pathlib import Path
import psycopg
from psycopg import DatabaseError, OperationalError, IntegrityError

class Row(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, (int, slice)) else super().__getitem__(key)

def row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))

# Quoted SQL literals/identifiers are left intact. Percent signs are escaped for psycopg.
def bind_sql(sql):
    return ''.join(part if part.startswith(("'", '"')) else part.replace('?', '%s')
                   for part in re.split(r'''('(?:''|[^'])*'|"(?:""|[^"])*")''', sql.replace('%', '%%')))

class Connection:
    def __init__(self):
        self.raw = psycopg.connect(os.environ['DATABASE_URL'], row_factory=row_factory,
                                  connect_timeout=10, options='-c statement_timeout=60000 -c lock_timeout=15000')
        self.created_files = []
    def execute(self, sql, parameters=None):
        if parameters is None:
            return self.raw.execute(sql)
        # Existing integer flags must stay integer columns (including bound Python bools).
        parameters = tuple(int(v) if isinstance(v, bool) else v for v in parameters)
        return self.raw.execute(bind_sql(sql), parameters)
    def track_file(self, path: Path):
        self.created_files.append(path)
    def _cleanup(self):
        for path in reversed(self.created_files):
            path.unlink(missing_ok=True)
            try: path.parent.rmdir()
            except OSError: pass
        self.created_files.clear()
    def commit(self):
        self.raw.commit()
        self.created_files.clear()
    def rollback(self):
        self.raw.rollback()
        self._cleanup()
    def close(self):
        self.raw.close()
    def __enter__(self):
        return self
    def __exit__(self, kind, error, tb):
        try:
            if kind is None:
                try: self.commit()
                except Exception:
                    self.rollback()
                    raise
            else:
                self.rollback()
        finally:
            self.close()
