"""Unit tests for on-demand Japanese G2P extras (no network)."""
import os
from pathlib import Path

import pytest

from sokuji_sidecar import runtime_extras as re


def test_extras_root_prefers_sokuji_extras_dir(monkeypatch, tmp_path):
    target = tmp_path / "extras"
    monkeypatch.setenv("SOKUJI_EXTRAS_DIR", str(target))
    monkeypatch.delenv("HF_HOME", raising=False)
    assert re.extras_root() == target.resolve()


def test_extras_root_sibling_of_hf_home(monkeypatch, tmp_path):
    hf = tmp_path / "hf-cache"
    monkeypatch.delenv("SOKUJI_EXTRAS_DIR", raising=False)
    monkeypatch.setenv("HF_HOME", str(hf))
    assert re.extras_root() == (tmp_path / "sidecar-extras").resolve()


def test_ensure_extras_on_path_inserts_sys_path(monkeypatch, tmp_path):
    monkeypatch.setenv("SOKUJI_EXTRAS_DIR", str(tmp_path / "e"))
    root = re.ensure_extras_on_path()
    assert root.is_dir()
    import sys
    assert str(root) in sys.path


def test_patch_unidic_dicdir(monkeypatch, tmp_path):
    pytest.importorskip("unidic")
    dic = tmp_path / "dicdir"
    dic.mkdir()
    (dic / "mecabrc").write_text("# dummy\n")
    re._patch_unidic_dicdir(dic)
    import unidic
    assert Path(unidic.DICDIR) == dic


def test_ensure_unidic_uses_existing_user_dic(monkeypatch, tmp_path):
    pytest.importorskip("unidic")
    extras = tmp_path / "extras"
    user_dic = extras / "unidic-dicdir"
    user_dic.mkdir(parents=True)
    (user_dic / "mecabrc").write_text("# dummy\n")
    monkeypatch.setenv("SOKUJI_EXTRAS_DIR", str(extras))
    re.ensure_unidic_dictionary()
    import unidic
    assert Path(unidic.DICDIR) == user_dic


def _hide_module(request, name: str) -> None:
    """Drop `name` (and submodules) from sys.modules; restore after the test."""
    import sys
    saved = {k: sys.modules.pop(k) for k in list(sys.modules)
             if k == name or k.startswith(name + ".")}

    def _restore():
        for k in list(sys.modules):
            if k == name or k.startswith(name + "."):
                sys.modules.pop(k, None)
        sys.modules.update(saved)

    request.addfinalizer(_restore)


def _block_import(monkeypatch, name: str) -> None:
    """Front-of-meta_path finder that hides `name` even if it is installed."""
    import sys

    class _Block:
        def find_spec(self, fullname, path, target=None):
            if fullname == name or fullname.startswith(name + "."):
                raise ModuleNotFoundError(fullname)
            return None

    monkeypatch.setattr(sys, "meta_path", [_Block(), *sys.meta_path])


def test_whisper_stub_provides_languages_without_openai_whisper(monkeypatch, request):
    import sys

    _hide_module(request, "whisper")
    _block_import(monkeypatch, "whisper")
    re._ensure_whisper_stub()

    from whisper.tokenizer import LANGUAGES
    assert LANGUAGES["en"] == "english"
    assert LANGUAGES["zh"] == "chinese"
    assert LANGUAGES["yue"] == "cantonese"
    langs = tuple(LANGUAGES.keys())
    assert langs.index("en") == 0
    assert langs.index("zh") == 1
    assert langs.index("yue") == len(langs) - 1
    assert "whisper" in sys.modules
    assert sys.modules["whisper"].tokenizer is sys.modules["whisper.tokenizer"]


def test_whisper_stub_does_not_replace_real_whisper(monkeypatch):
    import sys
    import types

    tok = types.ModuleType("whisper.tokenizer")
    tok.LANGUAGES = {"en": "SENTINEL"}
    mod = types.ModuleType("whisper")
    mod.tokenizer = tok
    monkeypatch.setitem(sys.modules, "whisper", mod)
    monkeypatch.setitem(sys.modules, "whisper.tokenizer", tok)

    re._ensure_whisper_stub()
    from whisper.tokenizer import LANGUAGES
    assert LANGUAGES == {"en": "SENTINEL"}

