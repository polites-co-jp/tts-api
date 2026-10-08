from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

from .backends import Backend, LoadedModel, OutOfMemory
from .catalog import MODELS_BY_ID

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ModelLoadError(RuntimeError):
    def __init__(self, model_id: str, message: str, *, out_of_memory: bool) -> None:
        super().__init__(message)
        self.model_id = model_id
        self.out_of_memory = out_of_memory


class ModelSlot:
    """GPU に載せるモデルは1つだけ。別のモデルが要るときは今のモデルを解放してから読み込む。

    GPU を触る処理は1本だけのワーカースレッドで順に実行する。リクエスト単位の順番は
    request_lock で守る（長文の分割を途中で他のリクエストに割り込ませない）。
    """

    def __init__(self, backend: Backend) -> None:
        self.backend = backend
        self.model_id: str | None = None
        self.model: LoadedModel | None = None
        self.loading_id: str | None = None
        self.last_error: str | None = None
        self.request_lock = asyncio.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")

    async def run(self, fn: Callable[[], T]) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn)

    def ensure_sync(self, model_id: str) -> float:
        """model_id を載せた状態にする。戻り値は読み込みにかかったミリ秒（載っていれば 0）。"""
        if self.model_id == model_id and self.model is not None:
            return 0.0
        spec = MODELS_BY_ID[model_id]
        self.unload_sync()
        self.loading_id = model_id
        t0 = time.perf_counter()
        try:
            logger.info("loading model %s (%s)", model_id, spec.checkpoint)
            self.model = self.backend.load(spec)
            self.model_id = model_id
            self.last_error = None
        except OutOfMemory as exc:
            self.last_error = f"{model_id}: out of memory"
            raise ModelLoadError(
                model_id, f"VRAM が足りず {model_id} を読み込めませんでした: {exc}", out_of_memory=True
            ) from exc
        except Exception as exc:
            self.last_error = f"{model_id}: {exc}"
            raise ModelLoadError(
                model_id, f"{model_id} を読み込めませんでした: {exc}", out_of_memory=False
            ) from exc
        finally:
            self.loading_id = None
        elapsed = (time.perf_counter() - t0) * 1000.0
        logger.info("loaded model %s in %.0f ms", model_id, elapsed)
        return elapsed

    def unload_sync(self) -> None:
        if self.model is None:
            self.model_id = None
            return
        logger.info("unloading model %s", self.model_id)
        model, self.model, self.model_id = self.model, None, None
        model.unload()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
