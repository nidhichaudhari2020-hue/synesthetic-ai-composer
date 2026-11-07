"""Run against an isolated provisioned database as app_runtime, never as admin."""
import os
from uuid import uuid4

import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.database import TrackRepository


@pytest.mark.integration
@pytest.mark.asyncio
async def test_pooled_identity_clears_after_commit_and_rollback():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set TEST_DATABASE_URL to a provisioned PostgreSQL database using app_runtime")
    repository = TrackRepository.__new__(TrackRepository)
    # Reuse exactly one connection so a leaking session context cannot hide in
    # a different pool slot. open() also enforces the runtime-role constraints.
    repository.pool = AsyncConnectionPool(url, min_size=1, max_size=1,
                                          kwargs={"row_factory": dict_row}, open=False)
    await repository.open()
    owner_a, owner_b = f"test-{uuid4()}", f"test-{uuid4()}"
    track_a = track_b = None
    try:
        track_a = await repository.create(owner_a, "A", {}, b"MThd")
        track_b = await repository.create(owner_b, "B", {}, b"MThd")
        assert (await repository.list(owner_a, 10, 0))["tracks"] == [track_a]
        assert (await repository.list(owner_b, 10, 0))["tracks"] == [track_b]
        assert await repository.midi(owner_b, track_a["id"]) is None
        assert not await repository.delete(owner_b, track_a["id"])
        with pytest.raises(RuntimeError, match="force rollback"):
            async with repository.tenant(owner_a) as connection:
                await connection.execute("SELECT 1")
                raise RuntimeError("force rollback")
        # No API tenant context: RLS must hide every row, including rows from
        # the preceding transaction that rolled back on this same connection.
        async with repository.pool.connection() as connection:
            cursor = await connection.execute("SELECT id FROM public.tracks")
            assert await cursor.fetchall() == []
            cursor = await connection.execute("SELECT NULLIF(current_setting('app.user_id', true), '') AS identity")
            assert (await cursor.fetchone())["identity"] is None
        assert await repository.midi(owner_a, track_a["id"]) == b"MThd"
    finally:
        if track_a:
            await repository.delete(owner_a, track_a["id"])
        if track_b:
            await repository.delete(owner_b, track_b["id"])
        await repository.close()
