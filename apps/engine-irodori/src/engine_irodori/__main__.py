from __future__ import annotations

import logging
import os

import uvicorn

from .app import create_app


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("ENGINE_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # Hugging Face からの取得で1ファイルごとに出る要求ログを抑える
    logging.getLogger("httpx").setLevel(logging.WARNING)
    uvicorn.run(
        create_app(),
        host=os.environ.get("ENGINE_HOST", "0.0.0.0"),
        port=int(os.environ.get("ENGINE_PORT", "8000")),
        log_level=os.environ.get("ENGINE_LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
