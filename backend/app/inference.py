import asyncio
import multiprocessing
from pathlib import Path

from fastapi import HTTPException


def _child_generate(connection, config, checkpoint):
    try:
        from app.ml import generate_track
        result = generate_track(config, checkpoint)
        connection.send((True, result))
    except Exception:
        # Exception strings may contain filesystem paths or corpus information.
        connection.send((False, None))
    finally:
        connection.close()


def run_isolated(config: dict, checkpoint: str, timeout: int):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_child_generate, args=(child, config, checkpoint), daemon=True)
    process.start()
    child.close()
    try:
        if not parent.poll(timeout):
            raise TimeoutError("Generation deadline exceeded")
        ok, result = parent.recv()
        if not ok:
            raise RuntimeError("Model generation failed")
        return result
    finally:
        parent.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
        process.close()


class InferenceService:
    def __init__(self, settings):
        self.settings = settings
        self.capacity = asyncio.Semaphore(settings.generation_concurrency)

    async def generate(self, config: dict):
        if not Path(self.settings.checkpoint_path).is_file():
            raise HTTPException(503, "A trained model must be deployed before generation")
        try:
            await asyncio.wait_for(self.capacity.acquire(), timeout=0.01)
        except TimeoutError:
            raise HTTPException(503, "Composer is busy; retry shortly", headers={"Retry-After": "10"}) from None
        config = {**config, "allow_synthetic_demo": self.settings.environment == "development"}
        job = asyncio.create_task(asyncio.to_thread(run_isolated, config, str(self.settings.checkpoint_path), self.settings.generation_timeout_seconds))
        # A disconnected/cancelled HTTP request must not release capacity while
        # its worker still consumes CPU. The completion callback owns the slot.
        def finished(task):
            self.capacity.release()
            if not task.cancelled():
                task.exception()  # retrieve failures even after client disconnect
        job.add_done_callback(finished)
        try:
            return await asyncio.shield(job)
        except TimeoutError:
            raise HTTPException(504, "Generation timed out") from None
        except (RuntimeError, EOFError, OSError):
            raise HTTPException(503, "Model generation unavailable") from None
