"""Lean desktop sidecar entry point for the MAO Chat macOS build.

Boots ASR, translation, model management and the full native TTS roster.
Model weights stay out of the app bundle and download on demand into the
user's cache; cards without a usable backend/tier stay hardware-gated.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys

from .server import serve


async def _run() -> None:
    # accel/tts_engine use this to expose only the lean runtime's backends.
    os.environ.setdefault("MAO_CHAT_LIVE_CAPTIONS_RUNTIME", "1")

    from . import tts_engine
    from .translate_engine import TranslateEngine, register as register_translate
    from .asr_engine import AsrEngine, register as register_asr
    from .native_models import register as register_models
    from .accel import register as register_accel

    state = {
        "tts_engine": tts_engine.TtsEngine(),
        "translate_engine": TranslateEngine(),
        "asr_engine": AsrEngine(),
    }
    tts_engine.register(state)
    register_translate(state)
    register_asr(state)
    register_models(state)
    register_accel(state)
    port, server = await serve(state)
    print(json.dumps({"port": port}), flush=True)
    await server.wait_closed()


def _install_exit_handlers() -> None:
    def _handler(_signum, _frame):
        raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        if signal.getsignal(sig) is signal.SIG_DFL:
            signal.signal(sig, _handler)


def main() -> None:
    _install_exit_handlers()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
