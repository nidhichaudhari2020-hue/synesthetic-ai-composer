from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool


class TrackRepository:
    def __init__(self, url: str):
        self.pool = AsyncConnectionPool(url, min_size=1, max_size=8, max_waiting=16, timeout=5,
                                       kwargs={"row_factory": dict_row}, open=False)

    async def open(self):
        await self.pool.open(wait=True, timeout=15)
        async with self.pool.connection() as conn:
            cursor = await conn.execute("""
                SELECT r.rolsuper, r.rolbypassrls, c.relrowsecurity, c.relforcerowsecurity,
                       pg_has_role(current_user, c.relowner, 'MEMBER') AS owns_table
                FROM pg_roles r CROSS JOIN pg_class c
                WHERE r.rolname = current_user AND c.oid = 'public.tracks'::regclass
            """)
            row = await cursor.fetchone()
            if not row or row["rolsuper"] or row["rolbypassrls"] or row["owns_table"] or not row["relrowsecurity"] or not row["relforcerowsecurity"]:
                raise RuntimeError("Database role or tenant isolation is unsafe")

    async def close(self):
        await self.pool.close()

    @asynccontextmanager
    async def tenant(self, owner_id: str):
        async with self.pool.connection() as conn:
            async with conn.transaction():
                # SET LOCAL through set_config is parameterized and cleared on commit/rollback.
                await conn.execute("SELECT set_config('app.user_id', %s, true)", (owner_id,))
                await conn.execute("SET LOCAL statement_timeout = '5000ms'")
                yield conn

    @staticmethod
    def public(row):
        return {"id": row["id"], "title": row["title"], "created_at": row["created_at"], **row["metadata"]}

    async def create(self, owner_id: str, title: str, metadata: dict, midi: bytes):
        track_id, created = uuid4(), datetime.now(timezone.utc)
        async with self.tenant(owner_id) as conn:
            await conn.execute("INSERT INTO public.tracks (id, owner_id, title, created_at, metadata, midi) VALUES (%s,%s,%s,%s,%s,%s)",
                               (track_id, owner_id, title, created, Jsonb(metadata), midi))
        return {"id": track_id, "title": title, "created_at": created, **metadata}

    async def list(self, owner_id: str, limit: int, offset: int):
        async with self.tenant(owner_id) as conn:
            cursor = await conn.execute("SELECT id,title,created_at,metadata FROM public.tracks WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s", (owner_id, limit + 1, offset))
            rows = await cursor.fetchall()
        return {"tracks": [self.public(row) for row in rows[:limit]], "next_offset": offset + limit if len(rows) > limit else None}

    async def midi(self, owner_id: str, track_id: UUID):
        async with self.tenant(owner_id) as conn:
            cursor = await conn.execute("SELECT midi FROM public.tracks WHERE id=%s AND owner_id=%s", (track_id, owner_id))
            row = await cursor.fetchone()
        return bytes(row["midi"]) if row else None

    async def delete(self, owner_id: str, track_id: UUID):
        async with self.tenant(owner_id) as conn:
            cursor = await conn.execute("DELETE FROM public.tracks WHERE id=%s AND owner_id=%s RETURNING id", (track_id, owner_id))
            return await cursor.fetchone() is not None
