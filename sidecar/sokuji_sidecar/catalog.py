"""Declarative model catalog: per model, which backends/hardware tiers run it
and what artifact each needs. Pure data — adding a model is adding a row.

Most ASR cards run on transcribe.cpp (ggml family, official handy-computer
GGUFs). The live-caption lane also carries small Sherpa ONNX cards, including
Hayamimi's language-routed specialist bundle. One GGUF serves the gpu-vulkan /
gpu-metal / cpu tiers; Sherpa rows stay CPU-native. Quants follow the author's
WER-validated cards: Q4_K_M for the big speech LLMs, Q8_0 for Whisper, and
Q6_K for Fun-ASR-MLT."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Deployment:
    backend: str        # backend NAME: "transcribe_cpp" | "sherpa_online" | "sherpa_offline" | "sherpa_tts" | "moss_onnx" | "supertonic" | "qwen3tts_onnx" | "mlx_audio_tts" | "llamacpp_qwen" | "llamacpp_hunyuan" | "llamacpp_gemma" | "ct2_opus_translate"
    tier: str           # "cpu" | "gpu-vulkan" | "gpu-metal" | "gpu-cuda" | "gpu-dml"
    compute_type: str   # quant/dtype label ("q4_k_m", "q8_0", "int8", ...)
    artifact: str       # backend.load() model_ref (repo id or "org/repo/file.gguf")
    rank: float         # tie-breaker within a tier (higher = preferred)
    est_bytes: int | None = None                     # footprint estimate; None → model_size(artifact)
    platforms: tuple[str, ...] = ("linux", "windows", "macos")  # OSes this deployment runs on (D9)
    requires_apple_silicon: bool = False             # gate: needs Apple Silicon (mlx / metal-only rows)


@dataclass(frozen=True)
class _ModelBase:
    """Shared shape for AsrModel/TranslateModel/TtsModel rows. Every construction
    passes id/name/languages/deployments positionally and everything else by
    keyword, so adding fields here (size_bytes) is safe for all call sites."""
    id: str
    name: str
    languages: tuple[str, ...]   # ("multi",) means any language
    deployments: tuple[Deployment, ...]
    recommended: bool = False
    sort_order: int = 99
    size_bytes: int = 0          # total download size; 0 = unknown
    download_ignore: tuple[str, ...] = ()  # fnmatch patterns skipped by the downloader
                                            # (mirrors native_models._base_specs' spec["ignore"])


@dataclass(frozen=True)
class AsrModel(_ModelBase):
    routes: tuple["AsrRoute", ...] = ()
    language_identifier: "AsrLanguageIdentifier | None" = None


@dataclass(frozen=True)
class AsrRoute:
    """One language route inside a composite ASR card.

    ``("multi",)`` is the fallback route. Model architecture belongs here,
    beside the artifact that exports it, rather than in backend filename or
    model-id guesses.
    """
    languages: tuple[str, ...]
    artifact: str
    architecture: str


@dataclass(frozen=True)
class AsrLanguageIdentifier:
    """A small local language-ID model used before a routed ASR decode.

    Some upstream releases are archives rather than Hugging Face snapshots.
    ``members`` names only the runtime files we extract, keeping examples and
    unused fp32 graphs out of MAO Chat's managed model cache.
    """
    architecture: str
    url: str
    cache_key: str
    members: tuple[str, ...]
    size_bytes: int


_TC_TIERS = ("gpu-vulkan", "gpu-metal", "cpu")
# GPU-only tier set for cards too large to run on CPU in practice (the 24B
# Voxtral). Dropping "cpu" makes the renderer hardware-gate the card off
# CPU-only machines (hardwareGated = no available non-cpu tier) instead of
# advertising an unusable multi-GB CPU download.
_TC_GPU_TIERS = ("gpu-vulkan", "gpu-metal")


def _tc_quant(fname):
    return fname.rsplit("-", 1)[1].removesuffix(".gguf").lower()


# Rank encodes the quant's ROLE, not just a tie-break:
#   2.0 = the curated default; 1.0 = curated alternative (recommendation
#   candidate); 0.5 = listed-only — shown in the variant list with a
#   supported flag, but never auto-recommended (e.g. f16: the author's WER
#   tables show no gain over q8_0, so recommending its 2x download would be
#   waste — power users can still pick it).
_TC_CURATED_MIN_RANK = 1.0


def _tc_row(mid, name, langs, repo, base, order, quants, default,
            recommended=False, backend="transcribe_cpp", tiers=_TC_TIERS):
    """One transcribe.cpp ASR card with its FULL quant ladder. `quants` maps
    QUANT (filename token, e.g. "Q8_0") -> size_bytes; `default` names the
    curated default. The same GGUF serves every tier. Deployments are ordered
    default-first so downloads/size_bytes key off the default; q6_k/q4_k_m/q8_0
    are curated recommendation candidates, f16/q5_k_m are listed-only."""
    curated = {"q8_0", "q6_k", "q4_k_m"}
    deps = []
    std_order = ("F16", "f16", "Q8_0", "q8_0", "Q6_K", "q6_k", "Q5_K_M", "q5_k_m", "Q4_K_M", "q4_k_m")
    rest = [q for q in std_order if q in quants and q != default]
    for q in quants:
        if q != default and q not in rest:
            rest.append(q)
    order_keys = [default] + rest
    for q in order_keys:
        quant = q.lower()
        rank = 2.0 if q == default else (1.0 if quant in curated else 0.5)
        deps += [Deployment(backend, tier, quant, f"{repo}/{base}-{q}.gguf", rank,
                            est_bytes=quants[q]) for tier in tiers]
    return AsrModel(mid, name, langs, tuple(deps), recommended=recommended,
                    sort_order=order, size_bytes=quants[default])


def _sherpa_online_row(mid, name, langs, repo, order, size_bytes, *, ignore=(),
                       recommended=True):
    """One small CPU-native Sherpa-ONNX streaming model.

    Every row points at a complete Hugging Face snapshot.  The shared ignores
    keep sample audio out of the download; language-specific rows can also
    exclude their unused fp32 siblings when an int8 export lives beside them.
    """
    return AsrModel(
        mid, name, langs,
        (Deployment("sherpa_online", "cpu", "int8", repo, 2.0,
                    est_bytes=size_bytes),),
        recommended=recommended, sort_order=order, size_bytes=size_bytes,
        download_ignore=("test_wavs/*", "*.wav", *ignore),
    )


def _sherpa_offline_row(mid, name, langs, repo, order, size_bytes, *, ignore=(),
                        recommended=True):
    """One CPU-native Sherpa offline model, segmented by the shared VAD."""
    return AsrModel(
        mid, name, langs,
        (Deployment("sherpa_offline", "cpu", "int8", repo, 2.0,
                    est_bytes=size_bytes),),
        recommended=recommended, sort_order=order, size_bytes=size_bytes,
        download_ignore=("test_wavs/*", "*.wav", *ignore),
    )


_HAYAMIMI_EU_LANGS = (
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el",
    "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es",
    "sv", "ru", "uk",
)

_HAYAMIMI_ROUTES = (
    AsrRoute(("ja",), "csukuangfj/reazonspeech-k2-v2-ja-en", "reazon_zipformer"),
    AsrRoute(("zh",),
             "csukuangfj/sherpa-onnx-paraformer-zh-int8-2025-10-07",
             "paraformer"),
    AsrRoute(("ko", "yue"),
             "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
             "sense_voice"),
    AsrRoute(_HAYAMIMI_EU_LANGS,
             "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
             "nemo_transducer"),
    AsrRoute(("multi",),
             "csukuangfj/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12",
             "omnilingual_ctc"),
)

_HAYAMIMI_LID = AsrLanguageIdentifier(
    architecture="whisper",
    url=("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
         "sherpa-onnx-whisper-tiny.tar.bz2"),
    cache_key="hayamimi-whisper-tiny-lid",
    members=("tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx"),
    size_bytes=116_204_861,
)



def _hayamimi_row():
    """Hayamimi's language router, trimmed to the int8 runtime assets.

    The five specialist snapshots and Whisper-tiny language identifier download
    together. Only the active specialist route is loaded at runtime.
    """
    route_bytes = 1_587_243_747
    return AsrModel(
        "hayamimi-asr", "Hayamimi ASR (Automatic Routing)", ("multi",),
        (Deployment("sherpa_offline", "cpu", "int8",
                    _HAYAMIMI_ROUTES[0].artifact, 3.0,
                    est_bytes=route_bytes + _HAYAMIMI_LID.size_bytes),),
        recommended=True, sort_order=-1,
        size_bytes=route_bytes + _HAYAMIMI_LID.size_bytes,
        download_ignore=(
            "test_wavs/*", "*.wav", "*.fp16.onnx",
            "encoder-epoch-35-avg-1.onnx",
            "decoder-epoch-35-avg-1.onnx",
            "joiner-epoch-35-avg-1.onnx",
            "model.onnx",
        ),
        routes=_HAYAMIMI_ROUTES,
        language_identifier=_HAYAMIMI_LID,
    )


# Curated ASR roster (2026-07-05 re-pick from the full transcribe.cpp family).
# sort_order = quality ranking, seeded from the author's UNIFORM benchmark
# (transcribe.cpp-measured librispeech test-clean WER, best rung per model;
# noted per row) — gaps of 10 leave room for hand-tuning; language-specialized
# cards (gigaam: ru) are slotted by their standing WITHIN their language, since
# the renderer's source-language filter means only those users see them.
ASR_MODELS: list[AsrModel] = [
    _hayamimi_row(),
    # macOS live-caption lane.  Language-specific rows are deliberately sorted
    # before the multilingual fallback, so changing the video language selects
    # the smallest/faster native model whenever Sherpa publishes one.
    _sherpa_offline_row(
        "sherpa-moonshine-base-ja-int8",
        "Moonshine Base Japanese (Native, Fast)",
        ("ja",),
        "csukuangfj2/sherpa-onnx-moonshine-base-ja-quantized-2026-02-27",
        0, 141_315_715),
    _sherpa_online_row(
        "sherpa-nemo-ctc-en-80ms-int8",
        "NeMo FastConformer English 80ms (Native Streaming)",
        ("en",),
        "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8",
        1, 132_060_302),
    _sherpa_online_row(
        "sherpa-zipformer-zh-int8", "Sherpa Zipformer Chinese (Native Streaming)",
        ("zh",), "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
        3, 167_360_920),
    _sherpa_online_row(
        "sherpa-zipformer-de-kroko", "Sherpa Zipformer German (Native Streaming)",
        ("de",), "csukuangfj/sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06",
        4, 71_051_469),
    _sherpa_online_row(
        "sherpa-zipformer-es-kroko", "Sherpa Zipformer Spanish (Native Streaming)",
        ("es",), "csukuangfj/sherpa-onnx-streaming-zipformer-es-kroko-2025-08-06",
        5, 155_838_792),
    _sherpa_online_row(
        "sherpa-zipformer-fr-kroko", "Sherpa Zipformer French (Native Streaming)",
        ("fr",), "csukuangfj/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06",
        6, 71_052_319),
    _sherpa_online_row(
        "sherpa-zipformer-ko-int8", "Sherpa Zipformer Korean (Native Streaming)",
        ("ko",), "k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16",
        7, 132_455_211,
        ignore=("encoder-epoch-99-avg-1.onnx", "decoder-epoch-99-avg-1.onnx",
                "joiner-epoch-99-avg-1.onnx")),
    _sherpa_online_row(
        "sherpa-zipformer-multi-8lang", "Sherpa Zipformer Arabic / Japanese / Russian + 5 (Native Streaming)",
        ("ar", "en", "id", "ja", "ru", "th", "vi", "zh"),
        "csukuangfj/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10",
        8, 339_349_396, recommended=False),
    # WER 1.25 — best-in-benchmark all-rounder; historical usage #1.
    _tc_row("cohere-transcribe-03-2026", "Cohere Transcribe",
            ("en", "de", "fr", "it", "es", "pt", "el",
             "nl", "pl", "ar", "vi", "zh", "ja", "ko"),
            "handy-computer/cohere-transcribe-03-2026-gguf", "cohere-transcribe-03-2026",
            10, {"F16": 4106644992, "Q8_0": 2410655232, "Q6_K": 1972524544,
                 "Q5_K_M": 1770270208, "Q4_K_M": 1558162944},
            default="Q4_K_M", recommended=True),
    # Arabic specialist from the Cohere family — no librispeech figure (ar
    # model); slotted top of its language view beside the flagship.
    _tc_row("cohere-transcribe-arabic-07-2026", "Cohere Transcribe (Arabic)",
            ("ar", "en"),
            "handy-computer/cohere-transcribe-arabic-07-2026-gguf", "cohere-transcribe-arabic-07-2026",
            12, {"F16": 4106644896, "Q8_0": 2410655136, "Q6_K": 1972524448,
                 "Q5_K_M": 1770270112, "Q4_K_M": 1558162848}, default="Q4_K_M"),
    # Russian specialist (GigaAM v3, end-to-end w/ punctuation) — no librispeech
    # figure (ru model); slotted top of its language view.
    _tc_row("gigaam-v3-e2e-rnnt", "GigaAM v3 (Russian)", ("ru",),
            "handy-computer/gigaam-v3-e2e-rnnt-gguf", "gigaam-v3-e2e-rnnt",
            15, {"F16": 452381408, "Q8_0": 273724832, "Q6_K": 227953952,
                 "Q5_K_M": 206392736, "Q4_K_M": 183948704}, default="Q8_0"),
    # Russian second rung — plain RNNT variant (no e2e punctuation head).
    _tc_row("granite-speech-4.1-2b", "Granite Speech 4.1 (2B)",
            ("en", "fr", "de", "es", "pt", "ja"),
            "handy-computer/granite-speech-4.1-2b-gguf", "granite-speech-4.1-2b",
            20, {"F16": 4632623104, "Q8_0": 2559878848, "Q6_K": 2024967936,
                 "Q5_K_M": 1829704544, "Q4_K_M": 1602904800}, default="Q4_K_M"),
    _tc_row("canary-1b-flash", "Canary 1B Flash", ("en", "de", "es", "fr"),
            "handy-computer/canary-1b-flash-gguf", "canary-1b-flash",
            35, {"F16": 1785657120, "Q8_0": 1048131360, "Q6_K": 857603872,
                 "Q5_K_M": 769563424, "Q4_K_M": 677141280}, default="Q4_K_M"),
    # Confucius4-R2T2: NetEase Youdao low-latency streaming ASR (Qwen3-ASR fine-tune w/ LSP decoding).
    _tc_row("confucius4-r2t2", "Confucius4-R2T2 (Streaming)",
            ("zh", "en", "yue", "ja", "ko", "ar", "de", "es",
             "fr", "it", "pt", "ru", "th", "vi", "id", "tr",
             "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs",
             "fil", "fa", "el", "hu", "mk", "ro", "multi"),
            "davidxifeng/Confucius4-R2T2-gguf", "r2t2",
            38, {"q8_0": 2477512064, "f16": 4092155264},
            default="q8_0", recommended=True),
    # WER 1.61 — CJK quality mainstay (verified all-5-langs correct on real clips).
    _tc_row("qwen3-asr-1.7b", "Qwen3-ASR 1.7B",
            ("zh", "en", "ja", "ko", "yue", "ar", "de", "es",
             "fr", "it", "pt", "ru", "th", "vi", "hi", "id"),
            "handy-computer/Qwen3-ASR-1.7B-gguf", "Qwen3-ASR-1.7B",
            40, {"F16": 4091390944, "Q8_0": 2185030624, "Q6_K": 1692554208,
                 "Q5_K_M": 1517290464, "Q4_K_M": 1319830496},
            default="Q4_K_M", recommended=True),
    # WER 1.69 (q6_k beats bf16 per the author's table) — 31-language coverage king.
    _tc_row("fun-asr-mlt-nano", "Fun-ASR MLT Nano",
            ("zh", "en", "yue", "ja", "ko", "vi", "id", "th", "ms", "fil", "ar",
             "hi", "bg", "hr", "cs", "da", "nl", "et", "fi", "el", "hu", "ga",
             "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "sv"),
            "handy-computer/Fun-ASR-MLT-Nano-2512-gguf", "Fun-ASR-MLT-Nano-2512",
            50, {"F16": 1667504192, "Q8_0": 891271232, "Q6_K": 690744384,
                 "Q5_K_M": 631129152, "Q4_K_M": 556975168},
            default="Q6_K", recommended=True),
    # WER 1.78 (q6_k ties bf16 — same quirk as the MLT sibling) — light zh/en/ja.
    _tc_row("fun-asr-nano", "Fun-ASR Nano", ("zh", "en", "ja"),
            "handy-computer/Fun-ASR-Nano-2512-gguf", "Fun-ASR-Nano-2512",
            55, {"F16": 1667503872, "Q8_0": 891270912, "Q6_K": 690744064,
                 "Q5_K_M": 631128832, "Q4_K_M": 556974848}, default="Q6_K"),
    # WER 1.81 — 99-language quality reference.
    _tc_row("canary-180m-flash", "Canary 180M Flash", ("en", "de", "es", "fr"),
            "handy-computer/canary-180m-flash-gguf", "canary-180m-flash",
            65, {"F16": 381632192, "Q8_0": 218447552, "Q6_K": 176291520,
                 "Q5_K_M": 158704320, "Q4_K_M": 139223744}, default="Q8_0"),
    # WER 1.91 — European quality tier (NVIDIA Canary, 25 langs).
    _tc_row("canary-1b-v2", "Canary 1B v2",
            ("bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el",
             "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es",
             "sv", "ru", "uk"),
            "handy-computer/canary-1b-v2-gguf", "canary-1b-v2",
            70, {"F16": 1966111456, "Q8_0": 1144290016, "Q6_K": 931986144,
                 "Q5_K_M": 836664032, "Q4_K_M": 735476448}, default="Q8_0"),
    # WER 2.01 — 99-language mainstay: ~large-v3 quality at 4x the speed.
    _tc_row("whisper-large-v3-turbo", "Whisper large-v3 turbo", ("multi",),
            "handy-computer/whisper-large-v3-turbo-gguf", "whisper-large-v3-turbo",
            90, {"F16": 1636749024, "Q8_0": 886381824, "Q6_K": 692536992,
                 "Q5_K_M": 619628192, "Q4_K_M": 536069792},
            default="Q8_0", recommended=True),
    # WER 2.07 — heavy streaming flagship (committed/tentative partials).
    _tc_row("voxtral-mini-4b-realtime", "Voxtral Mini 4B Realtime",
            ("en", "fr", "es", "de", "ru", "zh", "ja", "it", "pt", "nl", "ar", "hi", "ko"),
            "handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf", "Voxtral-Mini-4B-Realtime-2602",
            100, {"F16": 8879114528, "Q8_0": 4731791648, "Q6_K": 3661018912,
                  "Q5_K_M": 3281439008, "Q4_K_M": 2830493984},
            default="Q4_K_M", recommended=True, backend="transcribe_cpp_stream"),
    # WER 2.10 — light CJK quality rung.
    _tc_row("qwen3-asr-0.6b", "Qwen3-ASR 0.6B",
            ("zh", "en", "ja", "ko", "yue", "ar", "de", "es",
             "fr", "it", "pt", "ru", "th", "vi", "hi", "id"),
            "handy-computer/Qwen3-ASR-0.6B-gguf", "Qwen3-ASR-0.6B",
            110, {"F16": 1579793056, "Q8_0": 850423456, "Q6_K": 690417824,
                  "Q5_K_M": 645356192, "Q4_K_M": 589560480}, default="Q8_0"),
    # WER 2.16 — English STREAMING mid rung (MIT); upstream ships only
    # F16/Q8_0 rungs (plus an F32 we skip — the WER table is flat across all).
    _tc_row("moonshine-streaming-medium", "Moonshine Streaming Medium", ("en",),
            "handy-computer/moonshine-streaming-medium-gguf", "moonshine-streaming-medium",
            113, {"F16": 533781408, "Q8_0": 295793568},
            default="Q8_0", backend="transcribe_cpp_stream"),
    # WER 2.25 — Taiwanese Mandarin + zh/en code-switching (Whisper-large-v2
    # ft); the quant ladder is WER-flat so the smallest curated rung wins.
    _tc_row("breeze-asr-25", "Breeze ASR 25", ("zh", "en"),
            "handy-computer/Breeze-ASR-25-gguf", "Breeze-ASR-25",
            116, {"F16": 3106458208, "Q8_0": 1667964224, "Q6_K": 1296353280,
                 "Q5_K_M": 1160366080, "Q4_K_M": 996526080}, default="Q4_K_M"),
    # WER 2.29 — English-only streaming (NVIDIA Nemotron 3 ASR). Official
    # nvidia/nemotron-speech-streaming-en-0.6b; NVIDIA recommends this over
    # 3.5 for English-only. WER table is flat across curated rungs.
    _tc_row("nemotron-speech-streaming-en", "Nemotron ASR Streaming (English)",
            ("en",),
            "handy-computer/nemotron-speech-streaming-en-0.6b-gguf",
            "nemotron-speech-streaming-en-0.6b",
            120, {"F16": 1237652608, "Q8_0": 729650176, "Q6_K": 600420352,
                  "Q5_K_M": 538989568, "Q4_K_M": 475436032},
            default="Q8_0", recommended=True, backend="transcribe_cpp_stream"),
    # WER 3.03 — LIGHT streaming, 27 languages incl. zh/ja/ko (author-recommended).
    _tc_row("nemotron-3.5-asr-streaming", "Nemotron 3.5 ASR Streaming",
            ("en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi",
             "ja", "ko", "vi", "uk", "pl", "sv", "cs", "nb", "da", "bg", "fi",
             "hr", "sk", "zh", "hu", "ro", "et"),
            "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf", "nemotron-3.5-asr-streaming-0.6b",
            128, {"F16": 1277750240, "Q8_0": 751094240, "Q6_K": 621356512,
                  "Q5_K_M": 559647200, "Q4_K_M": 495831520},
            default="Q8_0", recommended=True, backend="transcribe_cpp_stream"),
    # WER 5.1 — the minimal 99-language floor for long-tail source languages.
    _tc_row("whisper-base", "Whisper base", ("multi",),
            "handy-computer/whisper-base-gguf", "whisper-base",
            140, {"F16": 151145760, "Q8_0": 84962880, "Q6_K": 67865664,
                  "Q5_K_M": 63786048, "Q4_K_M": 58870848}, default="Q8_0"),
]


def asr_models() -> list[AsrModel]:
    # Rank-ordered (sort_order asc) regardless of source arrangement, so the
    # 2026-07-20 expansion block can be appended to ASR_MODELS without
    # hand-positioning every row.
    return sorted(ASR_MODELS, key=lambda m: m.sort_order)


def asr_model(model_id: str) -> AsrModel | None:
    return next((m for m in ASR_MODELS if m.id == model_id), None)


@dataclass(frozen=True)
class TranslateModel(_ModelBase):
    # Qwen3/Qwen3.5 chat-template thinking-mode kill switch (mirrors the
    # substring checks in translate_backends.LlamaCppQwenBackend._payload):
    # disable_thinking sends chat_template_kwargs.enable_thinking=false,
    # append_no_think additionally appends the "/no_think" soft switch to the
    # system prompt (plain Qwen3 only, belt-and-braces per Qwen3's own docs).
    disable_thinking: bool = False
    append_no_think: bool = False


def split_artifact(artifact: str) -> tuple[str, str | None]:
    """'org/repo/path/to/file' -> ('org/repo', 'path/to/file'); plain repo -> (repo, None)."""
    parts = artifact.split("/")
    if len(parts) > 2:
        return "/".join(parts[:2]), "/".join(parts[2:])
    return artifact, None


# Upstream sources for the LLM translate cards' GGUF quants: (card_id, quant) ->
# (upstream repo, exact filename). Verified 2026-07-03 (Task-14 dry run + HF API
# size fetch). Upstream GGUF repos hold many quants each, so we must pin the
# exact filename per card-variant rather than snapshot-downloading the repo.
# NOTE the tencent filename case quirks are REAL upstream data (7B Q8 is
# `HY-MT2-...` while its siblings are `Hy-MT2-...`) — kept verbatim.
_GGUF_SOURCES = {
    ("qwen2.5-0.5b", "q8_0"):   ("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q8_0.gguf"),
    ("qwen2.5-0.5b", "q4_k_m"): ("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
    ("qwen3-0.6b", "q8_0"):     ("Qwen/Qwen3-0.6B-GGUF", "Qwen3-0.6B-Q8_0.gguf"),
    ("qwen3-0.6b", "q4_k_m"):   ("unsloth/Qwen3-0.6B-GGUF", "Qwen3-0.6B-Q4_K_M.gguf"),
    ("qwen3.5-0.8b", "q4_k_m"): ("unsloth/Qwen3.5-0.8B-GGUF", "Qwen3.5-0.8B-Q4_K_M.gguf"),
    ("qwen3.5-0.8b", "q8_0"):   ("unsloth/Qwen3.5-0.8B-GGUF", "Qwen3.5-0.8B-Q8_0.gguf"),
    ("qwen3.5-2b", "q4_k_m"):   ("unsloth/Qwen3.5-2B-GGUF", "Qwen3.5-2B-Q4_K_M.gguf"),
    ("qwen3.5-2b", "q8_0"):     ("unsloth/Qwen3.5-2B-GGUF", "Qwen3.5-2B-Q8_0.gguf"),
    ("translategemma-4b", "q4_k_m"): ("mradermacher/translategemma-4b-it-GGUF", "translategemma-4b-it.Q4_K_M.gguf"),
    ("translategemma-4b", "q8_0"):   ("mradermacher/translategemma-4b-it-GGUF", "translategemma-4b-it.Q8_0.gguf"),
    ("hy-mt2-1.8b", "q4_k_m"):  ("tencent/Hy-MT2-1.8B-GGUF", "Hy-MT2-1.8B-Q4_K_M.gguf"),
    ("hy-mt2-1.8b", "q8_0"):    ("tencent/Hy-MT2-1.8B-GGUF", "Hy-MT2-1.8B-Q8_0.gguf"),
    ("hy-mt2-7b", "q4_k_m"):    ("tencent/Hy-MT2-7B-GGUF", "Hy-MT2-7B-Q4_K_M.gguf"),
    ("hy-mt2-7b", "q8_0"):      ("tencent/Hy-MT2-7B-GGUF", "HY-MT2-7B-Q8_0.gguf"),
    ("confucius4-t3po-14b", "q5_k_m"): ("netease-youdao/Confucius4-T3PO-GGUF", "Confucius4-T3PO-Q5_K_M.gguf"),
    ("confucius4-t3po-14b", "q4_k_m"): ("mradermacher/Confucius4-T3PO-GGUF", "Confucius4-T3PO.Q4_K_M.gguf"),
    ("confucius4-t3po-14b", "q6_k"):   ("netease-youdao/Confucius4-T3PO-GGUF", "Confucius4-T3PO-Q6_K.gguf"),
    ("confucius4-t3po-14b", "q8_0"):   ("mradermacher/Confucius4-T3PO-GGUF", "Confucius4-T3PO.Q8_0.gguf"),
}


def _gguf_artifact(mid: str, quant: str) -> str:
    repo, fname = _GGUF_SOURCES[(mid, quant)]
    return f"{repo}/{fname}"


def _opus_repo(mid: str) -> str:
    return f"jiangzhuo9357/{mid}-ct2"


def _llm_translate_row(mid, name, family, sort_order, default_quant, default_bytes,
                       alt_quant, alt_bytes, recommended=False,
                       disable_thinking=False, append_no_think=False,
                       extra_quants: tuple[tuple[str, int], ...] = ()):
    """An LLM card: one llamacpp backend, two or more GGUF quant variants, four tiers
    each (gpu-cuda / gpu-metal / gpu-vulkan / cpu). The same GGUF serves every
    tier; rank 2.0 marks the default quant. Plan ORDER across tiers is decided
    by accel.TIER_RANK (gpu-cuda/gpu-metal 3.0 > gpu-vulkan 2.5 > cpu 1.0), not
    by the order of this tuple."""
    backend = f"llamacpp_{family}"
    deps = []
    quant_specs = [(default_quant, default_bytes, 2.0), (alt_quant, alt_bytes, 1.0)]
    for eq, eq_bytes in extra_quants:
        quant_specs.append((eq, eq_bytes, 0.5))
    for quant, nbytes, rank in quant_specs:
        artifact = _gguf_artifact(mid, quant)
        deps += [Deployment(backend, tier, quant, artifact, rank, est_bytes=nbytes)
                 for tier in ("gpu-cuda", "gpu-metal", "gpu-vulkan", "cpu")]
    return TranslateModel(mid, name, ("multi",), tuple(deps),
                          recommended=recommended, sort_order=sort_order,
                          size_bytes=default_bytes, disable_thinking=disable_thinking,
                          append_no_think=append_no_think)


def _opus_row(src, tgt, sort_order, size_bytes=115_000_000):
    mid = f"opus-mt-{src}-{tgt}"
    name = f"Opus-MT ({_opus_disp(src)} → {_opus_disp(tgt)})"
    return TranslateModel(mid, name, (src, tgt), (
        Deployment("ct2_opus_translate", "cpu", "int8", _opus_repo(mid), 1.0),
    ), sort_order=sort_order, size_bytes=size_bytes)


# Opus-MT display: the en→ja repo keeps Helsinki's "jap" token, but the card
# should read "ja". Only this one code is remapped for the label.
_OPUS_DISP = {"jap": "ja"}


def _opus_disp(code):
    return _OPUS_DISP.get(code, code)


# Sizes are the exact upstream GGUF file byte counts (HF API size fetch,
# 2026-07-03 — see _GGUF_SOURCES). Opus size_bytes are the 5-file CT2 sums
# (config.json + model.bin + shared_vocabulary.json + source.spm + target.spm)
# of the jiangzhuo9357/opus-mt-*-ct2 repos, HF API fetch 2026-07-06 (see
# OPUS_FILES in native_models.py).
TRANSLATE_MODELS: list[TranslateModel] = [
    _llm_translate_row("qwen2.5-0.5b", "Qwen 2.5 0.5B", "qwen", 1,
                       "q8_0", 675710816, "q4_k_m", 491400032, recommended=True),
    _llm_translate_row("qwen3-0.6b", "Qwen 3 0.6B", "qwen", 2,
                       "q8_0", 639446688, "q4_k_m", 396705472, recommended=True,
                       disable_thinking=True, append_no_think=True),
    _llm_translate_row("qwen3.5-0.8b", "Qwen 3.5 0.8B", "qwen", 3,
                       "q4_k_m", 532517120, "q8_0", 811843840,
                       disable_thinking=True),
    _llm_translate_row("qwen3.5-2b", "Qwen 3.5 2B", "qwen", 4,
                       "q4_k_m", 1280835840, "q8_0", 2012012800,
                       disable_thinking=True),
    _llm_translate_row("translategemma-4b", "TranslateGemma 4B", "gemma", 5,
                       "q4_k_m", 2489909760, "q8_0", 4130417920),
    _llm_translate_row("hy-mt2-1.8b", "Hunyuan-MT2 1.8B", "hunyuan", 6,
                       "q4_k_m", 1133080448, "q8_0", 1908528192),
    _llm_translate_row("hy-mt2-7b", "Hunyuan-MT2 7B", "hunyuan", 7,
                       "q4_k_m", 4624648896, "q8_0", 7981928896),
    _llm_translate_row("confucius4-t3po-14b", "Confucius4-T3PO 14B", "qwen", 8,
                       "q5_k_m", 10_508_871_200, "q4_k_m", 8_988_109_280,
                       extra_quants=(("q6_k", 12_124_681_760), ("q8_0", 15_701_596_640))),
    _opus_row("ru", "en", 20, 82459917), _opus_row("zh", "en", 21, 82483063),
    _opus_row("en", "zh", 22, 82482780), _opus_row("hu", "en", 23, 81185270),
    _opus_row("en", "es", 24, 82471554), _opus_row("en", "ar", 25, 81957408),
    _opus_row("en", "ru", 26, 82459917), _opus_row("es", "en", 27, 82471554),
    _opus_row("en", "vi", 28, 76183416), _opus_row("ar", "en", 29, 81988818),
    _opus_row("ja", "en", 30, 80132256), _opus_row("en", "jap", 31, 72783549),
    _opus_row("ko", "en", 32, 82628751),
]


def translate_models() -> list[TranslateModel]:
    return list(TRANSLATE_MODELS)


def translate_model(model_id: str) -> TranslateModel | None:
    return next((m for m in TRANSLATE_MODELS if m.id == model_id), None)


@dataclass(frozen=True)
class License:
    """Non-standard license terms attached to a model card (e.g. CC-BY-NC).
    Generic DATA, not hardcoded UI: most cards carry no restriction and leave
    TtsModel.license as None; only a card that needs it (OmniVoice, issue
    #351) sets one, and the download gate (Task 2) reads this rather than
    special-casing a model id."""
    spdx: str             # SPDX identifier ("CC-BY-NC-4.0")
    name: str             # human-readable license name
    url: str              # license text URL
    non_commercial: bool  # True gates commercial use
    source_repo: str      # upstream repo this license traces back to
    attribution: str      # required attribution string (author/project)


@dataclass(frozen=True)
class TtsModel(_ModelBase):
    repos: tuple[str, ...] = ()      # HF repos to download
    urls: tuple[str, ...] = ()       # extra files (e.g. a vocoder .onnx)
    clones: bool = False             # zero-shot voice cloning from a reference clip
    streaming: bool = False          # intra-utterance audio-delta streaming
    sample_rate: int = 24000         # native rate (engine resamples to 24k)
    num_speakers: int = 1            # 1 = single voice; >1 = a 0..N-1 speaker range
    named_voices: bool = False       # has named preset voices (dropdown), not a bare sid range
    style_voices: bool = False       # custom voices are uploaded style-vector JSONs (Supertonic)
    transcript_required: bool = False  # ICL voice cloning needs the reference clip's transcript
    license: License | None = None   # non-standard license terms; None = no restriction


def _sherpa_tts_row(mid, name, langs, repo, sort_order, sr, urls=(), recommended=False,
                     num_speakers=1, size_bytes=0, download_ignore=()):
    # CPU-only by reality: the stock sherpa-onnx wheel bundles a CPU-only ORT
    # (runtime-verified, D11) — no GPU tier row.
    return TtsModel(mid, name, langs, (
        Deployment("sherpa_tts", "cpu", "fp32", repo, 1.0),
    ), repos=(repo,), urls=tuple(urls), sample_rate=sr,
       recommended=recommended, sort_order=sort_order, num_speakers=num_speakers,
       size_bytes=size_bytes, download_ignore=download_ignore)


def voice_capability(model: "TtsModel") -> dict:
    """Two-axis native voice capability derived from static catalog facts.
    builtin: named (preset dropdown) | range (sid slider) | none (single voice).
    custom:  clip (reference audio)  | style (uploaded JSON) | none."""
    custom = "clip" if model.clones else "style" if model.style_voices else "none"
    builtin = "named" if model.named_voices else "range" if model.num_speakers > 1 else "none"
    out = {"builtin": builtin, "custom": custom}
    if custom == "clip" and getattr(model, "transcript_required", False):
        out["transcriptRequired"] = True
    return out


def license_dict(model: "TtsModel") -> dict | None:
    """Wire-format (camelCase) serialization of TtsModel.license, or None when
    the card carries no non-standard license terms."""
    lic = model.license
    if lic is None:
        return None
    return {
        "spdx": lic.spdx,
        "name": lic.name,
        "url": lic.url,
        "nonCommercial": lic.non_commercial,
        "sourceRepo": lic.source_repo,
        "attribution": lic.attribution,
    }


_MOSS_NANO_LM_REPO = os.environ.get(
    "SOKUJI_MOSS_TTS_NANO_REPO", "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX")
_MOSS_NANO_TOK_REPO = os.environ.get(
    "SOKUJI_MOSS_TTS_NANO_TOK_REPO", "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX")
# Official hexgrad Kokoro-82M (PyTorch + misaki G2P) — same stack as the
# Hugging Face Space / Kokoro-FastAPI. Primary languages: en / zh / ja.
# Override only for debugging (e.g. a mirror of the same layout).
_KOKORO_82M_REPO = os.environ.get(
    "SOKUJI_KOKORO_82M_REPO", "hexgrad/Kokoro-82M")
# Bytes for config.json + kokoro-v1_0.pth + voices/*.pt (samples/eval ignored).
_KOKORO_82M_SIZE = 355_000_000

# Per-variant self-contained repos (spec P7): the repo IS the variant, rather
# than one repo with a CUDA-only bf16 subdir picked at load time. int8 was CUT
# from the shipping ladder — validated slower than fp32 on both aarch64 and
# x86 — so only fp32 (cpu + gpu-cuda + gpu-dml) and bf16 (gpu-cuda only) ship.
_QWEN3_TTS_06B_FP32 = os.environ.get(
    "SOKUJI_QWEN3_TTS_06B_REPO", "jiangzhuo9357/qwen3-tts-0.6b-onnx-fp32")
_QWEN3_TTS_06B_BF16 = "jiangzhuo9357/qwen3-tts-0.6b-onnx-bf16"
_QWEN3_TTS_17B_FP32 = os.environ.get(
    "SOKUJI_QWEN3_TTS_17B_REPO", "jiangzhuo9357/qwen3-tts-1.7b-onnx-fp32")
_QWEN3_TTS_17B_BF16 = "jiangzhuo9357/qwen3-tts-1.7b-onnx-bf16"

_GPT_SOVITS_REPO = os.environ.get(
    "SOKUJI_GPT_SOVITS_REPO", "jiangzhuo9357/gpt-sovits-v2pp-onnx")

_COSYVOICE3_REPO = os.environ.get(
    "SOKUJI_COSYVOICE3_REPO", "jiangzhuo9357/cosyvoice3-0.5b-onnx")

# OmniVoice (issue #351): corrected bidirectional re-export of k2-fsa/OmniVoice
# (the community onnx-community/OmniVoice-Onnx export bakes a causal mask into
# llm_decoder, which produces noise under this model's non-autoregressive
# iterative-unmasking decode — see scripts/reexport-omnivoice/out/README.md).
# 600+ language zero-shot cloning, transcript-free (no ICL reference text).
# Three self-contained per-variant repos (backbone at the repo ROOT + shared
# audio_tokenizer/ + voices/): only the CHOSEN precision downloads (qwen3-tts
# pattern). bf16 is the default (fastest + clean on CUDA); a naive fp16 export
# is CUDA-broken (RMSNorm x^2 overflow -> all-zero llm), so no fp16 variant.
_OMNIVOICE_BF16 = os.environ.get("SOKUJI_OMNIVOICE_BF16_REPO", "jiangzhuo9357/omnivoice-onnx-bidi-bf16")
_OMNIVOICE_FP32 = os.environ.get("SOKUJI_OMNIVOICE_FP32_REPO", "jiangzhuo9357/omnivoice-onnx-bidi-fp32")
_OMNIVOICE_INT4 = os.environ.get("SOKUJI_OMNIVOICE_INT4_REPO", "jiangzhuo9357/omnivoice-onnx-bidi-int4")

# macOS MLX TTS repos (spec D5): Apple-Silicon-only mlx-audio deployments of the
# same qwen3-tts / moss cards. Env-overridable like the ONNX repos above.
_MOSS_NANO_MLX_REPO = os.environ.get(
    "SOKUJI_MOSS_TTS_NANO_MLX_REPO", "mlx-community/MOSS-TTS-Nano-100M")
_QWEN3_TTS_06B_MLX_REPO = os.environ.get(
    "SOKUJI_QWEN3_TTS_06B_MLX_REPO", "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit")
_QWEN3_TTS_17B_MLX_REPO = os.environ.get(
    "SOKUJI_QWEN3_TTS_17B_MLX_REPO", "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit")

SUPERTONIC_LANGS = ("en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et",
                    "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl",
                    "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi")

# Pocket TTS (Kyutai CALM zero-shot voice cloning), int8 ONNX, one bundle per
# language — the flow-LM is language-specific; every bundle ships the same
# eight predefined voices (KV-cache prefixes in voices.bin). Upstream lives in
# SUBFOLDERS of the KevinAHM/pocket-tts-web SPACE, a shape the download path
# deliberately does not speak, so scripts/mirror_pocket_tts.py stages flat
# model-repo mirrors (bundle files + the voices/manifest.json the voice
# listing reads). size_bytes = the 9 upstream files + that 263-byte manifest.
# CPU-only by measurement: int8 seqlen-1 AR decode is memory-bound, 2.5-6.6x
# realtime on CPU, and the int8 operator set has no validated GPU kernel path.
_POCKET_TTS_ROWS = (
    ("en", "English",    4, 198645821),
    ("de", "German",     5, 198646300),
    ("es", "Spanish",    6, 198647361),
    ("it", "Italian",    7, 198646544),
    ("pt", "Portuguese", 8, 198647467),
)


def _pocket_tts_row(lang: str, label: str, order: int, size: int) -> TtsModel:
    repo = os.environ.get(f"SOKUJI_POCKET_TTS_{lang.upper()}_REPO",
                          f"jiangzhuo9357/pocket-tts-{lang}-onnx")
    return TtsModel(
        f"pocket-tts-{lang}", f"Pocket TTS ({label})", (lang,),
        (Deployment("pocket_onnx", "cpu", "int8", repo, 1.0),),
        repos=(repo,), clones=True, streaming=False, named_voices=True,
        sample_rate=24000, sort_order=order, size_bytes=size)


TTS_MODELS: list[TtsModel] = [
    TtsModel("moss-tts-nano", "MOSS-TTS-Nano (100M)",
             ("zh", "en", "ja", "ko", "de", "fr", "es", "pt", "it", "ru",
              "ar", "pl", "cs", "da", "sv", "el", "tr", "hu", "fa", "nl"),
             (Deployment("mlx_audio_tts", "gpu-metal", "fp32", _MOSS_NANO_MLX_REPO, 1.0,
                         platforms=("macos",), requires_apple_silicon=True),
              Deployment("moss_onnx", "gpu-cuda", "fp32", _MOSS_NANO_LM_REPO, 1.0),
              Deployment("moss_onnx", "gpu-dml", "fp32", _MOSS_NANO_LM_REPO, 1.0,
                         platforms=("windows",)),
              Deployment("moss_onnx", "cpu", "fp32", _MOSS_NANO_LM_REPO, 1.0)),
             repos=(_MOSS_NANO_LM_REPO, _MOSS_NANO_TOK_REPO),
             clones=True, streaming=True, named_voices=True, sample_rate=48000,
             recommended=True, sort_order=0, size_bytes=763206064),
    TtsModel("supertonic-3", "Supertonic 3", SUPERTONIC_LANGS,
             (Deployment("supertonic", "gpu-cuda", "fp32", "Supertone/supertonic-3", 1.0),
              Deployment("supertonic", "gpu-dml", "fp32", "Supertone/supertonic-3", 1.0,
                         platforms=("windows",)),
              Deployment("supertonic", "cpu", "fp32", "Supertone/supertonic-3", 1.0)),
             repos=("Supertone/supertonic-3",), clones=False, streaming=False,
             named_voices=True, style_voices=True, sample_rate=44100, num_speakers=10,
             recommended=True, sort_order=1, size_bytes=400_600_000,
             download_ignore=("audio_samples/*", "img/*")),
    TtsModel("qwen3-tts-0.6b", "Qwen3-TTS 0.6B",
             ("zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"),
             (Deployment("mlx_audio_tts", "gpu-metal", "fp32", _QWEN3_TTS_06B_MLX_REPO, 1.0,
                         platforms=("macos",), requires_apple_silicon=True),
              # Per-variant self-contained repos (fp32/bf16) — the repo IS the
              # variant; bf16 has CUDA-only kernels (no cpu/dml row).
              Deployment("qwen3tts_onnx", "gpu-cuda", "bf16", _QWEN3_TTS_06B_BF16, 1.2,
                         est_bytes=3_208_592_970),
              Deployment("qwen3tts_onnx", "gpu-cuda", "fp32", _QWEN3_TTS_06B_FP32, 1.0,
                         est_bytes=4_318_015_468),
              Deployment("qwen3tts_onnx", "gpu-dml", "fp32", _QWEN3_TTS_06B_FP32, 1.0,
                         platforms=("windows",), est_bytes=4_318_015_468),
              Deployment("qwen3tts_onnx", "cpu", "fp32", _QWEN3_TTS_06B_FP32, 1.0,
                         est_bytes=4_318_015_468)),
             repos=(_QWEN3_TTS_06B_FP32,), clones=True, streaming=False,
             transcript_required=True, named_voices=True, sample_rate=24000,
             recommended=True, sort_order=2, size_bytes=4_318_015_468),
    TtsModel("qwen3-tts-1.7b", "Qwen3-TTS 1.7B",
             ("zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"),
             (Deployment("mlx_audio_tts", "gpu-metal", "fp32", _QWEN3_TTS_17B_MLX_REPO, 1.0,
                         platforms=("macos",), requires_apple_silicon=True),
              # Per-variant self-contained repos (fp32/bf16) — the repo IS the
              # variant; bf16 has CUDA-only kernels (no cpu/dml row).
              Deployment("qwen3tts_onnx", "gpu-cuda", "bf16", _QWEN3_TTS_17B_BF16, 1.2,
                         est_bytes=5_316_372_654),
              Deployment("qwen3tts_onnx", "gpu-cuda", "fp32", _QWEN3_TTS_17B_FP32, 1.0,
                         est_bytes=8_374_470_096),
              Deployment("qwen3tts_onnx", "gpu-dml", "fp32", _QWEN3_TTS_17B_FP32, 1.0,
                         platforms=("windows",), est_bytes=8_374_470_096),
              Deployment("qwen3tts_onnx", "cpu", "fp32", _QWEN3_TTS_17B_FP32, 1.0,
                         est_bytes=8_374_470_096)),
             repos=(_QWEN3_TTS_17B_FP32,), clones=True, streaming=False,
             transcript_required=True, named_voices=True, sample_rate=24000,
             recommended=False, sort_order=3, size_bytes=8_374_470_096),
    TtsModel("kokoro-82m", "Kokoro 82M Official (en/zh/ja)",
             ("en", "zh", "ja"),
             (
                 # CUDA when available; CPU floor everywhere (macOS / offline).
                 Deployment("kokoro_official", "gpu-cuda", "fp32",
                            _KOKORO_82M_REPO, 2.0, platforms=("linux", "windows")),
                 Deployment("kokoro_official", "cpu", "fp32",
                            _KOKORO_82M_REPO, 1.0),
             ),
             repos=(_KOKORO_82M_REPO,), clones=False, streaming=False,
             named_voices=True, sample_rate=24000, num_speakers=41,
             recommended=True, sort_order=4, size_bytes=_KOKORO_82M_SIZE,
             # Demo/eval assets are not needed for offline synthesis.
             download_ignore=("samples/*", "eval/*", "DONATE.md",
                              "SAMPLES.md", "EVAL.md", "VOICES.md")),
    TtsModel("cosyvoice3-0.5b", "CosyVoice 3 0.5B",
             ("zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"),
             (
                 # GPU-only by design (issue #323): CPU RTF ~3.5 misses the
                 # realtime bar even on a 20-core box; no cpu row on purpose.
                 Deployment("cosyvoice3_onnx", "gpu-cuda", "fp32",
                            _COSYVOICE3_REPO, 1.0),
             ),
             repos=(_COSYVOICE3_REPO,),
             clones=True, named_voices=True, transcript_required=True,
             streaming=False, sample_rate=24000, num_speakers=1,
             # exact live-repo total (build output 3_721_010_968 + the
             # HF-generated .gitattributes the downloader also fetches)
             size_bytes=3_721_012_656,
             sort_order=9),
    # OmniVoice (issue #351): 600+ language zero-shot cloning, Qwen3-0.6B
    # backbone + Higgs Audio V2 codec, 32-step non-autoregressive iterative
    # unmasking. Transcript-free cloning (no ICL reference text needed) —
    # unlike CosyVoice3/Qwen3-TTS/GPT-SoVITS above. GPU-only by design: the
    # backbone variants are CUDA-tuned and no cpu row is shipped. Curated
    # presets (issue #351 follow-up): each variant repo ships
    # voices/{classic-zh,classic-ja,sarah}.wav (transcript-free — no .txt,
    # unlike CosyVoice3's ICL presets) + voices/manifest.json, so named_voices.
    # The variant picker is driven by compute_type (variantIds = seen_cts);
    # rank order sets the default via planner._tts_pick_quant: bf16 > fp32 > int4.
    #   bf16 — DEFAULT: fastest AND clean on CUDA (RTF 0.198 vs fp32 0.258 /
    #     int4 0.334, GB10). bf16's fp32-range exponent avoids the deep-layer
    #     RMSNorm x^2 overflow that makes a naive fp16 export emit an all-zero
    #     llm output on the CUDA EP — so there is deliberately no fp16 variant.
    #     bf16 + int4 also ship a bf16 audio_embeddings (verified lossless).
    #   fp32 — un-quantized reference. int4 — smallest download / low-VRAM.
    # THREE self-contained per-variant repos (qwen3-tts pattern) — DISTINCT
    # artifacts, so only the chosen precision downloads and the picker/status
    # flow (accel._downloaded_tts_variants / native_models.model_status's
    # any-variant-repo-cached branch) works with zero infra changes. Backend
    # loads the backbone from the repo ROOT (each repo IS one variant).
    # est_bytes = each repo's live total (HF files_metadata 2026-07-23):
    #   bf16 1.995 GB, fp32 3.208 GB, int4 1.352 GB (backbone + shared
    #   audio_tokenizer/ + voices/).
    TtsModel("omnivoice-0.6b", "OmniVoice 0.6B", ("multi",),
             (Deployment("omnivoice_onnx", "gpu-cuda", "bf16", _OMNIVOICE_BF16, 3.0, est_bytes=1_995_363_769),
              Deployment("omnivoice_onnx", "gpu-cuda", "fp32", _OMNIVOICE_FP32, 2.0, est_bytes=3_207_687_266),
              Deployment("omnivoice_onnx", "gpu-cuda", "int4", _OMNIVOICE_INT4, 1.0, est_bytes=1_352_217_204)),
             repos=(_OMNIVOICE_BF16,),   # default-variant (bf16) download repo
             clones=True, named_voices=True, transcript_required=False,
             streaming=False, sample_rate=24000, num_speakers=1,
             size_bytes=1_995_363_769,   # default (bf16) variant download
             sort_order=66,
             # k2-fsa/OmniVoice ships under CC-BY-NC-4.0 — non-commercial only.
             # This descriptor is DATA the download gate (Task 2) reads
             # generically; it isn't a Sokuji-specific restriction.
             license=License(
                 spdx="CC-BY-NC-4.0",
                 name="Creative Commons Attribution-NonCommercial 4.0 International",
                 url="https://creativecommons.org/licenses/by-nc/4.0/",
                 non_commercial=True,
                 source_repo="jiangzhuo9357/omnivoice-onnx-bidi-bf16",
                 attribution="k2-fsa/OmniVoice")),
    # GPT-SoVITS v2ProPlus via the vendored Genie-TTS ONNX runtime (issue #322).
    # gpu-cuda: measured 3x vs CPU on unified-memory aarch64 (GB10, RTF 0.2);
    # x86 discrete-GPU benefit unverified (per-step KV round-trip). The bench
    # reports rtf via the default builtin voice; bench-based tier demotion for
    # TTS is currently disconnected upstream (tts:-prefixed cache keys vs
    # unprefixed reads) — tracked as a follow-up. recommended stays False
    # until en/ja quality is validated (upstream reports; sudachi kanji
    # readings).
    TtsModel("gpt-sovits-v2pp", "GPT-SoVITS v2ProPlus",
             ("zh", "en", "ja"),
             (Deployment("gpt_sovits_onnx", "gpu-cuda", "fp32", _GPT_SOVITS_REPO, 1.0,
                         est_bytes=2_500_000_000),
              Deployment("gpt_sovits_onnx", "cpu", "fp32", _GPT_SOVITS_REPO, 1.0)),
             repos=(_GPT_SOVITS_REPO,), clones=True, streaming=False,
             transcript_required=True, named_voices=True, sample_rate=32000,
             recommended=False, sort_order=4, size_bytes=1_349_081_598),
    *(_pocket_tts_row(*row) for row in _POCKET_TTS_ROWS),
    # piper / vits single-voice models (one repo = one model = one voice).
    _sherpa_tts_row("csukuangfj/vits-piper-en_US-amy-low", "Amy (US)", ("en",),
                    "csukuangfj/vits-piper-en_US-amy-low", 10, 16000, recommended=True,
                    size_bytes=81105784),
    _sherpa_tts_row("csukuangfj/vits-piper-en_US-libritts_r-medium", "LibriTTS (US)", ("en",),
                    "csukuangfj/vits-piper-en_US-libritts_r-medium", 11, 22050, num_speakers=904,
                    size_bytes=96598330),
    _sherpa_tts_row("csukuangfj/vits-piper-en_US-ryan-low", "Ryan (US)", ("en",),
                    "csukuangfj/vits-piper-en_US-ryan-low", 12, 16000, size_bytes=81105775),
    _sherpa_tts_row("csukuangfj/vits-piper-en_US-lessac-medium", "Lessac (US)", ("en",),
                    "csukuangfj/vits-piper-en_US-lessac-medium", 13, 22050, size_bytes=81203669),
    _sherpa_tts_row("csukuangfj/vits-piper-en_GB-alan-low", "Alan (GB)", ("en",),
                    "csukuangfj/vits-piper-en_GB-alan-low", 14, 16000, size_bytes=81105800),
    _sherpa_tts_row("csukuangfj/vits-piper-de_DE-thorsten-low", "Thorsten", ("de",),
                    "csukuangfj/vits-piper-de_DE-thorsten-low", 15, 16000, size_bytes=81105739),
    _sherpa_tts_row("csukuangfj/vits-piper-de_DE-eva_k-x_low", "Eva K", ("de",),
                    "csukuangfj/vits-piper-de_DE-eva_k-x_low", 16, 16000, size_bytes=38629997),
    _sherpa_tts_row("csukuangfj/vits-piper-de_DE-kerstin-low", "Kerstin", ("de",),
                    "csukuangfj/vits-piper-de_DE-kerstin-low", 17, 16000, size_bytes=81105736),
    _sherpa_tts_row("csukuangfj/vits-piper-es_ES-davefx-medium", "DaveFX (ES)", ("es",),
                    "csukuangfj/vits-piper-es_ES-davefx-medium", 18, 22050, size_bytes=81203135),
    _sherpa_tts_row("csukuangfj/vits-piper-es_ES-carlfm-x_low", "CarlFM (ES)", ("es",),
                    "csukuangfj/vits-piper-es_ES-carlfm-x_low", 19, 16000, size_bytes=46131805),
    _sherpa_tts_row("csukuangfj/vits-piper-es_MX-ald-medium", "Ald (MX)", ("es",),
                    "csukuangfj/vits-piper-es_MX-ald-medium", 20, 22050, size_bytes=81203240),
    _sherpa_tts_row("csukuangfj/vits-piper-fr_FR-siwis-medium", "Siwis", ("fr",),
                    "csukuangfj/vits-piper-fr_FR-siwis-medium", 21, 22050, size_bytes=81204462),
    _sherpa_tts_row("csukuangfj/vits-piper-fr_FR-gilles-low", "Gilles", ("fr",),
                    "csukuangfj/vits-piper-fr_FR-gilles-low", 22, 16000, size_bytes=81106835),
    _sherpa_tts_row("csukuangfj/vits-piper-fr_FR-tom-medium", "Tom", ("fr",),
                    "csukuangfj/vits-piper-fr_FR-tom-medium", 23, 22050, size_bytes=81514557),
    _sherpa_tts_row("csukuangfj/vits-piper-it_IT-riccardo-x_low", "Riccardo", ("it",),
                    "csukuangfj/vits-piper-it_IT-riccardo-x_low", 24, 16000, size_bytes=46133363),
    _sherpa_tts_row("csukuangfj/vits-piper-it_IT-paola-medium", "Paola", ("it",),
                    "csukuangfj/vits-piper-it_IT-paola-medium", 25, 22050, size_bytes=81516749),
    _sherpa_tts_row("csukuangfj/vits-piper-ru_RU-denis-medium", "Denis", ("ru",),
                    "csukuangfj/vits-piper-ru_RU-denis-medium", 26, 22050, size_bytes=81203281),
    _sherpa_tts_row("csukuangfj/vits-piper-ru_RU-irina-medium", "Irina", ("ru",),
                    "csukuangfj/vits-piper-ru_RU-irina-medium", 27, 22050, size_bytes=81203392),
    _sherpa_tts_row("csukuangfj/vits-piper-ru_RU-dmitri-medium", "Dmitri", ("ru",),
                    "csukuangfj/vits-piper-ru_RU-dmitri-medium", 28, 22050, size_bytes=81203283),
    _sherpa_tts_row("csukuangfj/vits-piper-zh_CN-huayan-medium", "Huayan", ("zh",),
                    "csukuangfj/vits-piper-zh_CN-huayan-medium", 29, 22050, size_bytes=81204688),
    # NOTE: the previous id (csukuangfj/vits-icefall-zh-aishell3) 404s on HF —
    # this row was never downloadable. csukuangfj/vits-zh-aishell3 is the live
    # repo with the sherpa-ready flat layout (onnx + tokens.txt + lexicon.txt);
    # size is the kept subset (download ignores the torch ckpt/rule.far/int8).
    _sherpa_tts_row("csukuangfj/vits-zh-aishell3", "VITS (zh, aishell3)", ("zh",),
                    "csukuangfj/vits-zh-aishell3", 30, 16000, num_speakers=174,
                    size_bytes=123663994,
                    download_ignore=("G_AISHELL.pth", "rule.far", "vits-aishell3.int8.onnx")),
    # 2026-07-17 piper expansion (35 voices): first dedicated voices for
    # cs/da/el/fa/fi/hu/is/lv/no/ro/sk/sl/sv/vi plus nl/pl/pt/uk, and en/es/de
    # upgrades. Per-voice dataset licenses vetted commercial-clean (CC0 /
    # CC-BY / public domain; jenny_dioco's custom license permits commercial
    # use with attribution). Sizes are full-repo HF file sums (API, 2026-07-17).
    _sherpa_tts_row("csukuangfj/vits-piper-en_US-ljspeech-high", "LJSpeech HQ (US)", ("en",),
                    "csukuangfj/vits-piper-en_US-ljspeech-high", 31, 22050, size_bytes=132202824),
    _sherpa_tts_row("csukuangfj/vits-piper-en_GB-cori-high", "Cori (GB)", ("en",),
                    "csukuangfj/vits-piper-en_GB-cori-high", 32, 22050, size_bytes=132223111),
    _sherpa_tts_row("csukuangfj/vits-piper-en_GB-jenny_dioco-medium", "Jenny (GB)", ("en",),
                    "csukuangfj/vits-piper-en_GB-jenny_dioco-medium", 33, 22050, size_bytes=81203440),
    _sherpa_tts_row("csukuangfj/vits-piper-es_ES-sharvard-medium", "Sharvard (ES)", ("es",),
                    "csukuangfj/vits-piper-es_ES-sharvard-medium", 34, 22050, num_speakers=2,
                    size_bytes=94735673),
    _sherpa_tts_row("csukuangfj/vits-piper-de_DE-thorsten-medium", "Thorsten HQ", ("de",),
                    "csukuangfj/vits-piper-de_DE-thorsten-medium", 35, 22050, size_bytes=81203378),
    _sherpa_tts_row("csukuangfj/vits-piper-nl_NL-mls-medium", "MLS (NL)", ("nl",),
                    "csukuangfj/vits-piper-nl_NL-mls-medium", 36, 22050, num_speakers=52,
                    size_bytes=94588149),
    _sherpa_tts_row("csukuangfj/vits-piper-nl_BE-nathalie-medium", "Nathalie (BE)", ("nl",),
                    "csukuangfj/vits-piper-nl_BE-nathalie-medium", 37, 22050, size_bytes=81204764),
    _sherpa_tts_row("csukuangfj/vits-piper-nl_BE-rdh-medium", "RDH (BE)", ("nl",),
                    "csukuangfj/vits-piper-nl_BE-rdh-medium", 38, 22050, size_bytes=81107078),
    _sherpa_tts_row("csukuangfj/vits-piper-pl_PL-darkman-medium", "Darkman", ("pl",),
                    "csukuangfj/vits-piper-pl_PL-darkman-medium", 39, 22050, size_bytes=81204680),
    _sherpa_tts_row("csukuangfj/vits-piper-pl_PL-gosia-medium", "Gosia", ("pl",),
                    "csukuangfj/vits-piper-pl_PL-gosia-medium", 40, 22050, size_bytes=81204676),
    _sherpa_tts_row("csukuangfj/vits-piper-pl_PL-mc_speech-medium", "MC Speech", ("pl",),
                    "csukuangfj/vits-piper-pl_PL-mc_speech-medium", 41, 22050, size_bytes=81204878),
    _sherpa_tts_row("csukuangfj/vits-piper-pt_BR-faber-medium", "Faber (BR)", ("pt",),
                    "csukuangfj/vits-piper-pt_BR-faber-medium", 42, 22050, size_bytes=81204728),
    _sherpa_tts_row("csukuangfj/vits-piper-pt_BR-cadu-medium", "Cadu (BR)", ("pt",),
                    "csukuangfj/vits-piper-pt_BR-cadu-medium", 43, 22050, size_bytes=80950326),
    _sherpa_tts_row("csukuangfj/vits-piper-pt_PT-tugao-medium", "Tugao (PT)", ("pt",),
                    "csukuangfj/vits-piper-pt_PT-tugao-medium", 44, 22050, size_bytes=81204946),
    _sherpa_tts_row("csukuangfj/vits-piper-uk_UA-ukrainian_tts-medium", "Ukrainian TTS", ("uk",),
                    "csukuangfj/vits-piper-uk_UA-ukrainian_tts-medium", 45, 22050, num_speakers=3,
                    size_bytes=94734178),
    _sherpa_tts_row("csukuangfj/vits-piper-uk_UA-lada-x_low", "Lada", ("uk",),
                    "csukuangfj/vits-piper-uk_UA-lada-x_low", 46, 16000, size_bytes=38630003),
    _sherpa_tts_row("csukuangfj/vits-piper-cs_CZ-jirka-medium", "Jirka", ("cs",),
                    "csukuangfj/vits-piper-cs_CZ-jirka-medium", 47, 22050, size_bytes=81203535),
    _sherpa_tts_row("csukuangfj/vits-piper-da_DK-talesyntese-medium", "Talesyntese (DA)", ("da",),
                    "csukuangfj/vits-piper-da_DK-talesyntese-medium", 48, 22050, size_bytes=81204788),
    _sherpa_tts_row("csukuangfj/vits-piper-el_GR-rapunzelina-low", "Rapunzelina", ("el",),
                    "csukuangfj/vits-piper-el_GR-rapunzelina-low", 49, 16000, size_bytes=81107191),
    _sherpa_tts_row("csukuangfj/vits-piper-fa_IR-amir-medium", "Amir", ("fa",),
                    "csukuangfj/vits-piper-fa_IR-amir-medium", 50, 22050, size_bytes=81534929),
    _sherpa_tts_row("csukuangfj/vits-piper-fi_FI-harri-medium", "Harri", ("fi",),
                    "csukuangfj/vits-piper-fi_FI-harri-medium", 51, 22050, size_bytes=81204780),
    _sherpa_tts_row("csukuangfj/vits-piper-hu_HU-anna-medium", "Anna", ("hu",),
                    "csukuangfj/vits-piper-hu_HU-anna-medium", 52, 22050, size_bytes=81204933),
    _sherpa_tts_row("csukuangfj/vits-piper-hu_HU-berta-medium", "Berta", ("hu",),
                    "csukuangfj/vits-piper-hu_HU-berta-medium", 53, 22050, size_bytes=81204863),
    _sherpa_tts_row("csukuangfj/vits-piper-hu_HU-imre-medium", "Imre", ("hu",),
                    "csukuangfj/vits-piper-hu_HU-imre-medium", 54, 22050, size_bytes=81204934),
    _sherpa_tts_row("csukuangfj/vits-piper-is_IS-bui-medium", "Bui", ("is",),
                    "csukuangfj/vits-piper-is_IS-bui-medium", 55, 22050, size_bytes=94498026),
    _sherpa_tts_row("csukuangfj/vits-piper-is_IS-salka-medium", "Salka", ("is",),
                    "csukuangfj/vits-piper-is_IS-salka-medium", 56, 22050, size_bytes=94498023),
    _sherpa_tts_row("csukuangfj/vits-piper-is_IS-steinn-medium", "Steinn", ("is",),
                    "csukuangfj/vits-piper-is_IS-steinn-medium", 57, 22050, size_bytes=94498025),
    _sherpa_tts_row("csukuangfj/vits-piper-is_IS-ugla-medium", "Ugla", ("is",),
                    "csukuangfj/vits-piper-is_IS-ugla-medium", 58, 22050, size_bytes=94498021),
    _sherpa_tts_row("csukuangfj/vits-piper-lv_LV-aivars-medium", "Aivars", ("lv",),
                    "csukuangfj/vits-piper-lv_LV-aivars-medium", 59, 22050, size_bytes=81516346),
    _sherpa_tts_row("csukuangfj/vits-piper-no_NO-talesyntese-medium", "Talesyntese (NO)", ("no",),
                    "csukuangfj/vits-piper-no_NO-talesyntese-medium", 60, 22050, size_bytes=81204797),
    _sherpa_tts_row("csukuangfj/vits-piper-ro_RO-mihai-medium", "Mihai", ("ro",),
                    "csukuangfj/vits-piper-ro_RO-mihai-medium", 61, 22050, size_bytes=81204758),
    _sherpa_tts_row("csukuangfj/vits-piper-sk_SK-lili-medium", "Lili", ("sk",),
                    "csukuangfj/vits-piper-sk_SK-lili-medium", 62, 22050, size_bytes=81204859),
    _sherpa_tts_row("csukuangfj/vits-piper-sl_SI-artur-medium", "Artur", ("sl",),
                    "csukuangfj/vits-piper-sl_SI-artur-medium", 63, 22050, size_bytes=81204121),
    _sherpa_tts_row("csukuangfj/vits-piper-sv_SE-nst-medium", "NST (SV)", ("sv",),
                    "csukuangfj/vits-piper-sv_SE-nst-medium", 64, 22050, size_bytes=81107140),
    _sherpa_tts_row("csukuangfj/vits-piper-vi_VN-vais1000-medium", "VAIS 1000", ("vi",),
                    "csukuangfj/vits-piper-vi_VN-vais1000-medium", 65, 22050, size_bytes=81204827),
]


def tts_models() -> list[TtsModel]:
    return list(TTS_MODELS)


def tts_model(model_id: str) -> TtsModel | None:
    return next((m for m in TTS_MODELS if m.id == model_id), None)


# Sherpa-onnx TTS covers a large family of community repos (piper VITS, icefall
# VITS, matcha, kokoro) that the renderer exposes as per-voice cards keyed by
# their full HF repo path. SherpaTtsBackend downloads/loads any such repo, so we
# synthesize an ad-hoc model for repo ids that the short catalog doesn't list
# rather than forcing every voice into the catalog.
_SHERPA_TTS_HINTS = ("piper", "vits", "matcha", "kokoro", "icefall")


def resolve_tts_card(model_id: str) -> "TtsModel | None":
    """The static TTS card for `model_id`, or a synthesised ad-hoc card for an
    uncatalogued sherpa-onnx community voice (piper/vits/matcha/kokoro/icefall),
    or None for an unknown non-sherpa id."""
    model = tts_model(model_id)
    if model is not None:
        return model
    if any(h in model_id.lower() for h in _SHERPA_TTS_HINTS):
        return TtsModel(
            id=model_id, name=model_id, languages=("multi",),
            deployments=(Deployment("sherpa_tts", "cpu", "fp32", model_id, 1.0),),
            repos=(model_id,), sample_rate=16000)
    return None
