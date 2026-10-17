"""Lightweight built-in TTS voice listing: read voice names from the MOSS model
manifest (browser_poc_manifest.json) WITHOUT loading any ONNX session."""
import json
from pathlib import Path

from .moss_tts.ort_runtime import OrtCpuRuntime

_DEFAULT_REPO = "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX"


def _repo_cached(repo: str) -> bool:
    """True if `repo`'s snapshot is fully cached locally. Uses native_models'
    _repos_cached (the .incomplete-aware check): an INTERRUPTED download of the
    default repo must not shadow a fully-cached alternate variant in
    _variant_repo's repos[0]-first walk — a partial snapshot resolves via
    snapshot_download but may lack voices/, silently emptying the preset list."""
    from . import native_models
    try:
        return native_models._repos_cached({"repos": [repo]})
    except Exception:
        return False


def _variant_repo(m) -> str:
    """Pick which of a (possibly multi-variant) TTS card's repos to read
    voices/ from: the first one that's actually cached locally — `m.repos[0]`
    checked first, then the card's other unique deployment-artifact repos in
    deployment order — falling back to `m.repos[0]` when none is cached.
    voices/ content is identical across a card's variant repos (same model,
    different dtype), so any cached one serves; this lets voice listing work
    off a downloaded bf16 repo without also requiring the default fp32 repo."""
    candidates = list(dict.fromkeys(
        [m.repos[0]] +
        [d.artifact for d in m.deployments if d.backend != "mlx_audio_tts"]))
    return next((r for r in candidates if _repo_cached(r)), m.repos[0])


def _repo_for(model_id: str | None) -> str:
    """Resolve a catalog TTS id (e.g. 'moss-tts-nano') to its HF LM repo — repos[0]
    carries browser_poc_manifest.json. None → the default MOSS model. An id that
    isn't in the catalog is treated as a raw repo path (a direct repo id still
    works). The renderer sends catalog short ids, NOT repo paths."""
    from . import catalog
    lookup = model_id or "moss-tts-nano"
    m = catalog.tts_model(lookup)
    if m and m.repos:
        return _variant_repo(m)
    return model_id or _DEFAULT_REPO   # unknown id → assume it's already a repo path


def _snapshot_dir(repo: str) -> str:
    from huggingface_hub import snapshot_download
    return snapshot_download(repo_id=repo, local_files_only=True)


def list_builtin_voice_names(model_id: str | None = None) -> list[str]:
    """Voice names from the snapshot manifest; [] if the model isn't downloaded.
    `model_id` is a catalog TTS id (resolved to its HF repo); None → default MOSS."""
    try:
        root = Path(_snapshot_dir(_repo_for(model_id)))
        manifest_path = OrtCpuRuntime._resolve_manifest_path(root)
        manifest = json.loads(manifest_path.read_text())
        return [str(v["voice"]) for v in manifest.get("builtin_voices", [])]
    except Exception:
        return []


# Built-in MOSS voice curation — our editorial product judgment (mirrors the old
# renderer BUILTIN_VOICE_META). Quality verified for English (Ava reliably clean);
# others are best-effort by language. Unstable voices stay reachable behind
# "show all" (see issue #277).
_VOICE_META = {
    "Ava":    {"language": "en", "curated": True},
    "Bella":  {"language": "en", "curated": True},
    "Adam":   {"language": "en", "unstable": True},
    "Nathan": {"language": "en"},
    "Trump":  {"language": "en"},
    "Xiaoyu": {"language": "zh", "curated": True},
    "Yuewen": {"language": "zh", "curated": True},
    "Lingyu": {"language": "zh"},
    "Junhao": {"language": "zh"},
    "Zhiming":{"language": "zh", "unstable": True},
    "Weiguo": {"language": "zh"},
    "Saki":   {"language": "ja", "curated": True},
    "Soyo":   {"language": "ja", "curated": True},
    "Umiri":  {"language": "ja"},
    "Mei":    {"language": "ja"},
    "Anon":   {"language": "ja", "unstable": True},
    "Arisa":  {"language": "ja"},
    "Mortis": {"unstable": True},
}
_DEFAULT_VOICE_BY_LANG = {"en": "Ava", "zh": "Xiaoyu", "ja": "Saki"}


def default_builtin_voice_name(lang: str | None = None) -> str:
    """Language-default MOSS preset (Xiaoyu/Saki/Ava). Unknown lang → Ava."""
    key = (lang or "").split("-", 1)[0].strip().lower()
    return _DEFAULT_VOICE_BY_LANG.get(key, "Ava")


def _read_moss_manifest(model_id: str | None = None) -> dict | None:
    """Load browser_poc_manifest.json from a cached ONNX snapshot, or None."""
    try:
        root = Path(_snapshot_dir(_repo_for(model_id)))
        manifest_path = OrtCpuRuntime._resolve_manifest_path(root)
        return json.loads(manifest_path.read_text())
    except Exception:
        return None


def load_builtin_voice_codes(name: str | None, model_id: str | None = None) -> list[list[int]] | None:
    """Return MOSS ``prompt_audio_codes`` for a built-in voice.

    MLX moss_tts_nano.generate() needs these codes (or a ref wav); a voice
    name alone raises and the renderer skips the sentence. Reads the ONNX
    snapshot's manifest (same source as list_builtin_voice_names). Returns
    None when the snapshot isn't cached or the name is unknown.
    """
    manifest = _read_moss_manifest(model_id)
    if manifest is None:
        manifest = _fetch_moss_manifest(model_id)
    if not manifest:
        return None
    voices = manifest.get("builtin_voices") or []
    if not voices:
        return None
    wanted = (name or "").strip()
    if wanted:
        match = next(
            (v for v in voices
             if str(v.get("voice") or "").lower() == wanted.lower()),
            None,
        )
        if match is None:
            return None
        codes = match.get("prompt_audio_codes")
    else:
        codes = voices[0].get("prompt_audio_codes")
    if not codes:
        return None
    return [list(row) for row in codes]


def _fetch_moss_manifest(model_id: str | None = None) -> dict | None:
    """Best-effort: pull just browser_poc_manifest.json (~500KB) from the ONNX repo.

    Apple Silicon downloads the MLX weights only, so the ONNX snapshot (and
    its builtin codes) may be missing. A one-file fetch unblocks MLX generate
    without pulling the multi-hundred-MB ONNX graphs.
    """
    try:
        from huggingface_hub import hf_hub_download
        repo = _repo_for(model_id)
        path = hf_hub_download(repo_id=repo, filename="browser_poc_manifest.json")
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def list_builtin_voices(model_id=None):
    """Rich built-in voice descriptors: each manifest voice name annotated with
    our curation metadata. [] when the model isn't downloaded. The single source
    of built-in voice facts for the renderer (replaces its BUILTIN_VOICE_META).

    Style-voice models (Supertonic) don't ship a MOSS-style manifest: their 10
    presets are baked into the backend and available without a download."""
    from . import catalog
    m = catalog.tts_model(model_id) if model_id else None
    if m is not None and m.id == "kokoro-82m":
        # Prefer official hexgrad voice list (en/zh/ja). Fall back to the
        # sherpa multi-lang map only if the official module is unavailable.
        try:
            from .kokoro_official import kokoro_official_voice_descriptors
            return kokoro_official_voice_descriptors()
        except Exception:
            from .sherpa_tts_common import kokoro_voice_descriptors
            return kokoro_voice_descriptors()
    if m is not None and getattr(m, "style_voices", False):
        from .tts_backends import SupertonicBackend
        return [{"name": x["voice"], "language": None, "gender": x["gender"],
                 "curated": True, "unstable": False, "default": (x["voice"] == "Robert")}
                for x in SupertonicBackend.list_builtin_voices()]
    if m is not None and m.id.startswith("qwen3-tts"):
        # macOS prefers the MLX CustomVoice repo, which has baked-in speakers
        # (vivian/serena/…) rather than voices/manifest.json. Prefer an ONNX
        # ICL manifest when that snapshot is cached; otherwise expose the
        # CustomVoice speaker list so the picker is never empty after an MLX
        # download (the failure mode that left generate() without a voice).
        try:
            root = Path(_snapshot_dir(_variant_repo(m)))
            manifest_path = root / "voices" / "manifest.json"
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text())
                return [{"name": e["name"], "language": None, "gender": e.get("gender"),
                         "curated": True, "unstable": False, "default": bool(e.get("default"))}
                        for e in manifest]
        except Exception:
            pass
        from .mlx_tts import qwen3_custom_voice_descriptors
        return qwen3_custom_voice_descriptors()
    if m is not None and m.repos:
        # Generic bundled-voices branch: any TTS model may ship curated ICL preset
        # clips as voices/<name>.wav|.txt + voices/manifest.json in its snapshot.
        # Falls through when the model isn't downloaded or doesn't bundle voices
        # this way. _variant_repo prefers a cached variant repo (e.g. bf16) over
        # the card's default (fp32) so voice listing works off whichever variant
        # the user actually downloaded.
        try:
            root = Path(_snapshot_dir(_variant_repo(m)))
            manifest_path = root / "voices" / "manifest.json"
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text())
                return [{"name": e["name"], "language": None, "gender": e.get("gender"),
                         "curated": True, "unstable": False, "default": bool(e.get("default"))}
                        for e in manifest]
        except Exception:
            pass
    names = list_builtin_voice_names(model_id)
    # macOS MLX downloads skip the ONNX snapshot that carries the manifest.
    # Still expose the curated name list so the picker / session default a
    # voice (Xiaoyu/Saki/Ava) instead of generate() running with no clone.
    if not names and (model_id in (None, "", "moss-tts-nano")
                      or (m is not None and m.id == "moss-tts-nano")):
        names = list(_VOICE_META)
    out = []
    for name in names:
        meta = _VOICE_META.get(name, {})
        lang = meta.get("language")
        out.append({
            "name": name,
            "language": lang,
            "curated": bool(meta.get("curated")),
            "unstable": bool(meta.get("unstable")),
            "default": (_DEFAULT_VOICE_BY_LANG.get(lang) == name) if lang else False,
        })
    return out
