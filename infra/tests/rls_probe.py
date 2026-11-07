"""Real PostgreSQL negative isolation probes; all probe rows are rolled back."""
from __future__ import annotations
import os
import uuid
import psycopg


def verify_isolation(dsn: str) -> None:
    first, second, forbidden = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    alice, bob = f"rls-probe-alice-{first}", f"rls-probe-bob-{second}"
    with psycopg.connect(dsn, autocommit=False) as conn:
        try:
            role = conn.execute("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user").fetchone()
            assert role and role[0] == "app_runtime" and not role[1] and not role[2]
            conn.execute("SELECT set_config('app.user_id', %s, true)", (alice,))
            conn.execute("INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES(%s,%s,'isolation probe','{}',%s)", (first, alice, b"MThd"))
            conn.execute("SELECT set_config('app.user_id', %s, true)", (bob,))
            conn.execute("INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES(%s,%s,'isolation probe','{}',%s)", (second, bob, b"MThd"))
            # An unscoped query is still scoped by the database.
            assert conn.execute("SELECT id FROM tracks WHERE id = ANY(%s)", ([first, second],)).fetchall() == [(second,)]
            assert conn.execute("SELECT midi FROM tracks WHERE id=%s", (first,)).fetchone() is None
            assert conn.execute("UPDATE tracks SET title='stolen' WHERE id=%s RETURNING id", (first,)).fetchone() is None
            assert conn.execute("DELETE FROM tracks WHERE id=%s RETURNING id", (first,)).fetchone() is None
            # Savepoints recover from deliberately rejected statements.
            for query, params in [
                ("INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES(%s,%s,'forged','{}',%s)", (forbidden, alice, b"MThd")),
                ("UPDATE tracks SET owner_id=%s WHERE id=%s", (alice, second)),
            ]:
                try:
                    with conn.transaction():
                        conn.execute(query, params)
                except psycopg.errors.InsufficientPrivilege:
                    pass
                else:
                    raise AssertionError("RLS accepted a forged owner")
            conn.execute("SELECT set_config('app.user_id', '', true)")
            assert conn.execute("SELECT id FROM tracks WHERE id = ANY(%s)", ([first, second],)).fetchall() == []
            conn.rollback()
            # Transaction-local identity must disappear before a pooled connection is reused.
            assert conn.execute("SELECT NULLIF(current_setting('app.user_id', true), '')").fetchone() == (None,)
        finally:
            conn.rollback()


if __name__ == "__main__":
    verify_isolation(os.environ["RLS_TEST_DATABASE_URL"])
    print("Passed: runtime role, cross-tenant list/read/update/delete, owner forgery, missing identity and transaction reset.")
