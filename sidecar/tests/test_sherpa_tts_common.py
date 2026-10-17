from types import SimpleNamespace

import pytest

from sokuji_sidecar.sherpa_tts_common import (
    KOKORO_VOICE_NAMES,
    build_offline_tts_config,
)


class _Config:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _fake_sherpa():
    return SimpleNamespace(
        OfflineTtsKokoroModelConfig=_Config,
        OfflineTtsVitsModelConfig=_Config,
        OfflineTtsModelConfig=_Config,
        OfflineTtsConfig=_Config,
    )


def test_kokoro_voice_map_is_complete():
    assert len(KOKORO_VOICE_NAMES) == 53
    assert len(set(KOKORO_VOICE_NAMES)) == 53
    assert KOKORO_VOICE_NAMES[:4] == ("af_alloy", "af_aoede", "af_bella", "af_heart")
    assert KOKORO_VOICE_NAMES[-1] == "zm_yunyang"


def test_build_config_detects_kokoro_assets(tmp_path):
    for filename in (
        "model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt",
        "lexicon-gb-en.txt", "lexicon-zh.txt", "date-zh.fst", "phone-zh.fst",
        "number-zh.fst",
    ):
        (tmp_path / filename).touch()
    (tmp_path / "espeak-ng-data").mkdir()
    (tmp_path / "dict").mkdir()

    cfg = build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")
    kokoro = cfg.model.kokoro
    assert kokoro.model.endswith("model.onnx")
    assert kokoro.voices.endswith("voices.bin")
    assert kokoro.data_dir.endswith("espeak-ng-data")
    assert kokoro.dict_dir.endswith("dict")
    assert kokoro.lexicon == ",".join([
        str(tmp_path / "lexicon-us-en.txt"),
        str(tmp_path / "lexicon-gb-en.txt"),
        str(tmp_path / "lexicon-zh.txt"),
    ])
    assert cfg.rule_fsts.count(",") == 2
    assert cfg.model.provider == "cpu"


def test_build_config_prefers_fp32_over_int8(tmp_path):
    for filename in (
        "model.onnx", "model.int8.onnx", "voices.bin", "tokens.txt",
        "lexicon-us-en.txt",
    ):
        (tmp_path / filename).touch()
    (tmp_path / "espeak-ng-data").mkdir()
    cfg = build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")
    assert cfg.model.kokoro.model.endswith("model.onnx")


def test_build_config_preserves_piper_vits_branch(tmp_path):
    (tmp_path / "model.onnx").touch()
    (tmp_path / "tokens.txt").touch()
    (tmp_path / "espeak-ng-data").mkdir()
    cfg = build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")
    assert cfg.model.vits.model.endswith("model.onnx")
    assert cfg.model.vits.data_dir.endswith("espeak-ng-data")


def test_build_config_reports_incomplete_download_clearly(tmp_path):
    with pytest.raises(FileNotFoundError, match="download is incomplete"):
        build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")


def test_build_config_rejects_partial_kokoro_instead_of_treating_it_as_vits(tmp_path):
    (tmp_path / "model.int8.onnx").touch()
    with pytest.raises(FileNotFoundError, match="voices.bin, tokens.txt"):
        build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")


def test_build_config_rejects_partial_fp32_kokoro_with_lexicon_marker(tmp_path):
    (tmp_path / "model.onnx").touch()
    (tmp_path / "lexicon-us-en.txt").touch()
    with pytest.raises(FileNotFoundError, match="voices.bin, tokens.txt"):
        build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")


def test_build_config_falls_back_to_int8_when_fp32_absent(tmp_path):
    for filename in ("model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt"):
        (tmp_path / filename).touch()
    (tmp_path / "espeak-ng-data").mkdir()
    cfg = build_offline_tts_config(_fake_sherpa(), str(tmp_path), "cpu")
    assert cfg.model.kokoro.model.endswith("model.int8.onnx")
