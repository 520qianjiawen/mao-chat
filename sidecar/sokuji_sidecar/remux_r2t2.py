"""Remux Confucius4-R2T2 from audio.cpp format to transcribe.cpp Qwen3-ASR format."""
from __future__ import annotations

import json
import mmap
import os
import struct
import time
from pathlib import Path

import gguf
import numpy as np

# Mapping tables
AUDIO_TOP_TABLE = [
    ("thinker.audio_tower.conv2d1.weight", "enc.conv.0.weight"),
    ("thinker.audio_tower.conv2d1.bias",   "enc.conv.0.bias"),
    ("thinker.audio_tower.conv2d2.weight", "enc.conv.1.weight"),
    ("thinker.audio_tower.conv2d2.bias",   "enc.conv.1.bias"),
    ("thinker.audio_tower.conv2d3.weight", "enc.conv.2.weight"),
    ("thinker.audio_tower.conv2d3.bias",   "enc.conv.2.bias"),
    ("thinker.audio_tower.conv_out.weight", "enc.conv_out.weight"),
    ("thinker.audio_tower.ln_post.weight", "enc.ln_post.weight"),
    ("thinker.audio_tower.ln_post.bias",   "enc.ln_post.bias"),
    ("thinker.audio_tower.proj1.weight",   "enc.proj1.weight"),
    ("thinker.audio_tower.proj1.bias",     "enc.proj1.bias"),
    ("thinker.audio_tower.proj2.weight",   "enc.proj2.weight"),
    ("thinker.audio_tower.proj2.bias",     "enc.proj2.bias"),
]

AUDIO_BLOCK_TABLE = [
    ("self_attn_layer_norm.weight", "norm_attn.weight"),
    ("self_attn_layer_norm.bias",   "norm_attn.bias"),
    ("self_attn.q_proj.weight",     "attn.q.weight"),
    ("self_attn.q_proj.bias",       "attn.q.bias"),
    ("self_attn.k_proj.weight",     "attn.k.weight"),
    ("self_attn.k_proj.bias",       "attn.k.bias"),
    ("self_attn.v_proj.weight",     "attn.v.weight"),
    ("self_attn.v_proj.bias",       "attn.v.bias"),
    ("self_attn.out_proj.weight",   "attn.out.weight"),
    ("self_attn.out_proj.bias",     "attn.out.bias"),
    ("final_layer_norm.weight",     "norm_ffn.weight"),
    ("final_layer_norm.bias",       "norm_ffn.bias"),
    ("fc1.weight",                  "ffn.fc1.weight"),
    ("fc1.bias",                    "ffn.fc1.bias"),
    ("fc2.weight",                  "ffn.fc2.weight"),
    ("fc2.bias",                    "ffn.fc2.bias"),
]

TEXT_TOP_TABLE = [
    ("thinker.model.embed_tokens.weight", "dec.token_embd.weight"),
    ("thinker.model.norm.weight",         "dec.output_norm.weight"),
]

TEXT_BLOCK_TABLE = [
    ("input_layernorm.weight",          "norm_attn.weight"),
    ("post_attention_layernorm.weight", "norm_ffn.weight"),
    ("self_attn.q_proj.weight",         "attn.q.weight"),
    ("self_attn.k_proj.weight",         "attn.k.weight"),
    ("self_attn.v_proj.weight",         "attn.v.weight"),
    ("self_attn.o_proj.weight",         "attn.o.weight"),
    ("self_attn.q_norm.weight",         "attn.q_norm.weight"),
    ("self_attn.k_norm.weight",         "attn.k_norm.weight"),
    ("mlp.gate_proj.weight",            "ffn.gate.weight"),
    ("mlp.up_proj.weight",              "ffn.up.weight"),
    ("mlp.down_proj.weight",            "ffn.down.weight"),
]

LANGUAGE_TO_BCP47 = {
    "Chinese":    "zh",
    "English":    "en",
    "Cantonese":  "yue",
    "Arabic":     "ar",
    "German":     "de",
    "French":     "fr",
    "Spanish":    "es",
    "Portuguese": "pt",
    "Indonesian": "id",
    "Italian":    "it",
    "Korean":     "ko",
    "Russian":    "ru",
    "Thai":       "th",
    "Vietnamese": "vi",
    "Japanese":   "ja",
    "Turkish":    "tr",
    "Hindi":      "hi",
    "Malay":      "ms",
    "Dutch":      "nl",
    "Swedish":    "sv",
    "Danish":     "da",
    "Finnish":    "fi",
    "Polish":     "pl",
    "Czech":      "cs",
    "Filipino":   "fil",
    "Persian":    "fa",
    "Greek":      "el",
    "Romanian":   "ro",
    "Hungarian":  "hu",
    "Macedonian": "mk",
}

TOKEN_TYPE_NORMAL = 1
TOKEN_TYPE_CONTROL = 3


def _read_str(f):
    length = struct.unpack("<Q", f.read(8))[0]
    return f.read(length).decode("utf-8", errors="replace")


def _read_val(f, vtype):
    if vtype == 0: return struct.unpack("<B", f.read(1))[0]
    if vtype == 1: return struct.unpack("<b", f.read(1))[0]
    if vtype == 2: return struct.unpack("<H", f.read(2))[0]
    if vtype == 3: return struct.unpack("<h", f.read(2))[0]
    if vtype == 4: return struct.unpack("<I", f.read(4))[0]
    if vtype == 5: return struct.unpack("<i", f.read(4))[0]
    if vtype == 6: return struct.unpack("<f", f.read(4))[0]
    if vtype == 7: return bool(struct.unpack("<B", f.read(1))[0])
    if vtype == 8: return _read_str(f)
    if vtype == 9:
        elem_type = struct.unpack("<I", f.read(4))[0]
        count = struct.unpack("<Q", f.read(8))[0]
        if elem_type == 0: return f.read(count)
        return [_read_val(f, elem_type) for _ in range(count)]
    if vtype == 10: return struct.unpack("<Q", f.read(8))[0]
    if vtype == 11: return struct.unpack("<q", f.read(8))[0]
    if vtype == 12: return struct.unpack("<d", f.read(8))[0]
    raise ValueError(f"Unknown type {vtype}")


def _skip_gguf_val(f, vt: int):
    if vt in (0, 1, 7): f.read(1)
    elif vt in (2, 3): f.read(2)
    elif vt in (4, 5, 6): f.read(4)
    elif vt in (10, 11, 12): f.read(8)
    elif vt == 8:
        length = struct.unpack("<Q", f.read(8))[0]
        f.read(length)
    elif vt == 9:
        elem_type = struct.unpack("<I", f.read(4))[0]
        count = struct.unpack("<Q", f.read(8))[0]
        if elem_type == 0:
            f.read(count)
        else:
            for _ in range(count):
                _skip_gguf_val(f, elem_type)


def mel_filterbank_numpy(sr=16000, n_fft=400, n_mels=128, fmin=0.0, fmax=8000.0):
    def hz_to_mel(f):
        f_sp = 200.0 / 3
        min_log_hz = 1000.0
        min_log_mel = (min_log_hz - 0.0) / f_sp
        logstep = np.log(6.4) / 27.0
        m = np.empty_like(f)
        lin_mask = f < min_log_hz
        m[lin_mask] = (f[lin_mask] - 0.0) / f_sp
        m[~lin_mask] = min_log_mel + np.log(f[~lin_mask] / min_log_hz) / logstep
        return m

    def mel_to_hz(m):
        f_sp = 200.0 / 3
        min_log_hz = 1000.0
        min_log_mel = (min_log_hz - 0.0) / f_sp
        logstep = np.log(6.4) / 27.0
        f = np.empty_like(m)
        lin_mask = m < min_log_mel
        f[lin_mask] = m[lin_mask] * f_sp
        f[~lin_mask] = min_log_hz * np.exp(logstep * (m[~lin_mask] - min_log_mel))
        return f

    m_min = hz_to_mel(np.array([fmin]))[0]
    m_max = hz_to_mel(np.array([fmax]))[0]
    m_pts = np.linspace(m_min, m_max, n_mels + 2)
    f_pts = mel_to_hz(m_pts)
    fft_freqs = np.linspace(0.0, sr / 2.0, n_fft // 2 + 1)
    weights = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)

    for i in range(n_mels):
        f_prev = f_pts[i]
        f_curr = f_pts[i + 1]
        f_next = f_pts[i + 2]
        lower = (fft_freqs - f_prev) / (f_curr - f_prev)
        upper = (f_next - fft_freqs) / (f_next - f_curr)
        weights[i] = np.maximum(0.0, np.minimum(lower, upper))
        enorm = 2.0 / (f_next - f_prev)
        weights[i] *= enorm

    return weights


def is_f32_target(dst_name: str) -> bool:
    if dst_name.endswith(".bias"):
        return True
    if "norm" in dst_name and dst_name.endswith(".weight"):
        return True
    if dst_name.endswith(".ln_post.weight"):
        return True
    if dst_name in ("frontend.mel_filterbank", "frontend.window"):
        return True
    return False


def is_conv_weight(dst_name: str) -> bool:
    return dst_name.startswith("enc.conv.") and dst_name.endswith(".weight")


def remux_r2t2(input_path: Path, output_path: Path) -> None:
    t0 = time.time()
    with open(input_path, "rb") as f:
        magic = f.read(4)
        if magic != b"GGUF":
            raise ValueError(f"Not a GGUF file: {magic}")
        version = struct.unpack("<I", f.read(4))[0]
        tensor_count = struct.unpack("<Q", f.read(8))[0]
        kv_count = struct.unpack("<Q", f.read(8))[0]

        kvs = {}
        for _ in range(kv_count):
            k = _read_str(f)
            vt = struct.unpack("<I", f.read(4))[0]
            v = _read_val(f, vt)
            kvs[k] = v

        source_tensors = {}
        for _ in range(tensor_count):
            tname = _read_str(f)
            n_dims = struct.unpack("<I", f.read(4))[0]
            dims = [struct.unpack("<Q", f.read(8))[0] for _ in range(n_dims)]
            raw_dtype = struct.unpack("<I", f.read(4))[0]
            offset = struct.unpack("<Q", f.read(8))[0]
            
            nelem = 1
            for d in dims: nelem *= d
            bs, ts = gguf.GGML_QUANT_SIZES[gguf.GGMLQuantizationType(raw_dtype)]
            nbytes = (nelem // bs) * ts
            source_tensors[tname] = {
                "dims": dims,
                "nelem": nelem,
                "raw_dtype": raw_dtype,
                "offset": offset,
                "nbytes": nbytes,
            }

        header_end = f.tell()
        data_start = (header_end + 31) & ~31

    names = kvs["audiocpp.embedded_files.names"]
    offsets = kvs["audiocpp.embedded_files.offsets"]
    data_blob = kvs["audiocpp.embedded_files.data"]

    embedded_files = {}
    for i, name in enumerate(names):
        start = offsets[i]
        end = offsets[i+1]
        embedded_files[name] = data_blob[start:end]

    config = json.loads(embedded_files["config.json"].decode("utf-8"))
    preproc = json.loads(embedded_files["preprocessor_config.json"].decode("utf-8"))
    vocab = json.loads(embedded_files["vocab.json"].decode("utf-8"))
    merges_lines = embedded_files["merges.txt"].decode("utf-8").splitlines()
    if merges_lines and merges_lines[0].startswith("#"):
        merges_lines = merges_lines[1:]
    tokcfg = json.loads(embedded_files["tokenizer_config.json"].decode("utf-8"))
    chat_template = None
    if "chat_template.json" in embedded_files:
        try:
            chat_template = json.loads(embedded_files["chat_template.json"].decode("utf-8")).get("chat_template")
        except Exception:
            pass

    vocab_size = int(config["thinker_config"]["text_config"]["vocab_size"])
    added = tokcfg.get("added_tokens_decoder", {}) or {}
    tok_by_id = {}
    for tok_str, tid in vocab.items():
        tok_by_id[int(tid)] = (tok_str, False)
    for tid_str, info in added.items():
        tid = int(tid_str)
        tok_by_id[tid] = (info["content"], bool(info.get("special", False)))

    tokens = []
    types = []
    for i in range(vocab_size):
        if i not in tok_by_id:
            tokens.append(f"<|unused_{i}|>")
            types.append(TOKEN_TYPE_NORMAL)
        else:
            t_str, is_spec = tok_by_id[i]
            tokens.append(t_str)
            types.append(TOKEN_TYPE_CONTROL if is_spec else TOKEN_TYPE_NORMAL)

    def _name_to_id(name_field: str):
        tok = tokcfg.get(name_field)
        if tok is None: return None
        if isinstance(tok, dict): tok = tok.get("content")
        if not tok: return None
        if tok in vocab: return vocab[tok]
        return next((int(tid) for tid, info in added.items() if info["content"] == tok), None)

    eos_id = _name_to_id("eos_token")
    pad_id = _name_to_id("pad_token")
    bos_id = _name_to_id("bos_token")

    thinker = config["thinker_config"]
    aenc = thinker["audio_config"]
    tdec = thinker["text_config"]
    rope_scaling = tdec.get("rope_scaling") or {}
    mrope_section = rope_scaling.get("mrope_section") or [24, 20, 20]
    mrope_interleaved = bool(rope_scaling.get("mrope_interleaved", True))

    sample_rate = int(preproc.get("sampling_rate", 16000))
    hop_length  = int(preproc["hop_length"])
    n_fft       = int(preproc["n_fft"])
    n_mels      = int(preproc["feature_size"])
    chunk_len   = int(preproc.get("chunk_length", 30))
    n_samples   = int(preproc.get("n_samples", chunk_len * sample_rate))
    nb_max_frm  = int(preproc.get("nb_max_frames", n_samples // hop_length))

    pub_names = config.get("support_languages", [])
    languages = [LANGUAGE_TO_BCP47.get(n, n) for n in pub_names]

    # Temporary file for atomic write
    tmp_target = output_path.with_name(f"{output_path.name}.tmp")
    writer = gguf.GGUFWriter(str(tmp_target), "qwen3_asr")

    writer.add_name("Confucius4-R2T2")
    writer.add_basename("qwen3-asr")
    writer.add_size_label("1.7B")
    writer.add_file_type(gguf.LlamaFileType.MOSTLY_Q8_0)
    writer.add_languages(languages)
    writer.add_author("NetEase Youdao")
    writer.add_organization("netease-youdao")
    writer.add_license("apache-2.0")
    writer.add_license_name("Apache License 2.0")
    writer.add_license_link("https://www.apache.org/licenses/LICENSE-2.0")
    writer.add_repo_url("https://huggingface.co/netease-youdao/Confucius4-R2T2")

    writer.add_string("stt.variant", "qwen3-asr-1.7b")
    writer.add_bool("stt.capability.lang_detect", True)

    writer.add_string("tokenizer.ggml.model", "gpt2")
    writer.add_string("tokenizer.ggml.pre", "qwen2")
    writer.add_array("tokenizer.ggml.tokens", tokens)
    writer.add_array("tokenizer.ggml.token_type", types)
    writer.add_array("tokenizer.ggml.merges", merges_lines)
    if eos_id is not None: writer.add_uint32("tokenizer.ggml.eos_token_id", eos_id)
    if pad_id is not None: writer.add_uint32("tokenizer.ggml.padding_token_id", pad_id)
    if bos_id is not None: writer.add_uint32("tokenizer.ggml.bos_token_id", bos_id)
    writer.add_bool("tokenizer.ggml.add_bos_token", False)
    if chat_template is not None:
        writer.add_string("tokenizer.chat_template", chat_template)

    writer.add_uint32("stt.qwen3_asr.encoder.n_layers", int(aenc["encoder_layers"]))
    writer.add_uint32("stt.qwen3_asr.encoder.d_model", int(aenc["d_model"]))
    writer.add_uint32("stt.qwen3_asr.encoder.n_heads", int(aenc["encoder_attention_heads"]))
    writer.add_uint32("stt.qwen3_asr.encoder.ffn_dim", int(aenc["encoder_ffn_dim"]))
    writer.add_uint32("stt.qwen3_asr.encoder.num_mel_bins", int(aenc["num_mel_bins"]))
    writer.add_uint32("stt.qwen3_asr.encoder.downsample_hidden", int(aenc["downsample_hidden_size"]))
    writer.add_uint32("stt.qwen3_asr.encoder.output_dim", int(aenc["output_dim"]))
    writer.add_uint32("stt.qwen3_asr.encoder.max_source_positions", int(aenc["max_source_positions"]))
    writer.add_uint32("stt.qwen3_asr.encoder.n_window", int(aenc["n_window"]))
    writer.add_uint32("stt.qwen3_asr.encoder.n_window_infer", int(aenc["n_window_infer"]))
    writer.add_uint32("stt.qwen3_asr.encoder.conv_chunksize", int(aenc["conv_chunksize"]))
    writer.add_string("stt.qwen3_asr.encoder.activation", str(aenc["activation_function"]).lower())

    writer.add_uint32("stt.qwen3_asr.decoder.n_layers", int(tdec["num_hidden_layers"]))
    writer.add_uint32("stt.qwen3_asr.decoder.hidden_size", int(tdec["hidden_size"]))
    writer.add_uint32("stt.qwen3_asr.decoder.intermediate_size", int(tdec["intermediate_size"]))
    writer.add_uint32("stt.qwen3_asr.decoder.n_heads", int(tdec["num_attention_heads"]))
    writer.add_uint32("stt.qwen3_asr.decoder.n_kv_heads", int(tdec["num_key_value_heads"]))
    writer.add_uint32("stt.qwen3_asr.decoder.head_dim", int(tdec["head_dim"]))
    writer.add_string("stt.qwen3_asr.decoder.hidden_act", str(tdec["hidden_act"]).lower())
    writer.add_float32("stt.qwen3_asr.decoder.rms_norm_eps", float(tdec["rms_norm_eps"]))
    writer.add_float32("stt.qwen3_asr.decoder.rope_theta", float(tdec["rope_theta"]))
    writer.add_uint32("stt.qwen3_asr.decoder.rope_mrope_section_t", int(mrope_section[0]))
    writer.add_uint32("stt.qwen3_asr.decoder.rope_mrope_section_h", int(mrope_section[1]))
    writer.add_uint32("stt.qwen3_asr.decoder.rope_mrope_section_w", int(mrope_section[2]))
    writer.add_bool("stt.qwen3_asr.decoder.rope_mrope_interleaved", mrope_interleaved)
    writer.add_uint32("stt.qwen3_asr.decoder.max_position_embeddings", int(tdec["max_position_embeddings"]))
    writer.add_bool("stt.qwen3_asr.decoder.tie_word_embeddings", bool(tdec.get("tie_word_embeddings", True)))
    writer.add_uint32("stt.qwen3_asr.decoder.vocab_size", int(tdec["vocab_size"]))

    writer.add_uint32("stt.qwen3_asr.audio_token_id", int(thinker["audio_token_id"]))
    writer.add_uint32("stt.qwen3_asr.audio_start_token_id", int(thinker["audio_start_token_id"]))
    writer.add_uint32("stt.qwen3_asr.audio_end_token_id", int(thinker["audio_end_token_id"]))

    writer.add_string("stt.frontend.type", "mel")
    writer.add_uint32("stt.frontend.num_mels", n_mels)
    writer.add_uint32("stt.frontend.sample_rate", sample_rate)
    writer.add_uint32("stt.frontend.n_fft", n_fft)
    writer.add_uint32("stt.frontend.win_length", n_fft)
    writer.add_uint32("stt.frontend.hop_length", hop_length)
    writer.add_string("stt.frontend.window", "hann_periodic")
    writer.add_string("stt.frontend.normalize", "per_utterance")
    writer.add_float32("stt.frontend.dither", float(preproc.get("dither", 0.0)))
    writer.add_float32("stt.frontend.pre_emphasis", 0.0)
    writer.add_float32("stt.frontend.f_min", 0.0)
    writer.add_float32("stt.frontend.f_max", float(sample_rate) / 2.0)
    writer.add_string("stt.frontend.pad_mode", "reflect")
    writer.add_bool("stt.frontend.center", True)
    writer.add_string("stt.frontend.mel_norm", "slaney")
    writer.add_uint32("stt.frontend.chunk_length", chunk_len)
    writer.add_uint32("stt.frontend.n_samples", n_samples)
    writer.add_uint32("stt.frontend.nb_max_frames", nb_max_frm)

    mel_fb = mel_filterbank_numpy(
        sr=sample_rate, n_fft=n_fft, n_mels=n_mels, fmin=0.0, fmax=float(sample_rate) / 2.0,
    )
    N = n_fft
    hann = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(N) / N)).astype(np.float32)

    tensor_tasks = []
    tensor_tasks.append({
        "dst_name": "frontend.mel_filterbank",
        "kind": "array",
        "array": np.ascontiguousarray(mel_fb),
        "raw_dtype": gguf.GGMLQuantizationType.F32,
    })
    tensor_tasks.append({
        "dst_name": "frontend.window",
        "kind": "array",
        "array": np.ascontiguousarray(hann),
        "raw_dtype": gguf.GGMLQuantizationType.F32,
    })

    for src, dst in AUDIO_TOP_TABLE:
        tensor_tasks.append({"dst_name": dst, "kind": "remux", "src_name": src})

    for i in range(int(aenc["encoder_layers"])):
        for suffix_src, suffix_dst in AUDIO_BLOCK_TABLE:
            tensor_tasks.append({
                "dst_name": f"enc.blocks.{i}.{suffix_dst}",
                "kind": "remux",
                "src_name": f"thinker.audio_tower.layers.{i}.{suffix_src}",
            })

    for src, dst in TEXT_TOP_TABLE:
        tensor_tasks.append({"dst_name": dst, "kind": "remux", "src_name": src})

    for i in range(int(tdec["num_hidden_layers"])):
        for suffix_src, suffix_dst in TEXT_BLOCK_TABLE:
            tensor_tasks.append({
                "dst_name": f"dec.blocks.{i}.{suffix_dst}",
                "kind": "remux",
                "src_name": f"thinker.model.layers.{i}.{suffix_src}",
            })

    for t in tensor_tasks:
        if t["kind"] == "array":
            arr = t["array"]
            writer.add_tensor_info(
                t["dst_name"],
                tensor_shape=arr.shape,
                tensor_dtype=arr.dtype,
                tensor_nbytes=arr.nbytes,
                raw_dtype=t["raw_dtype"],
            )
        else:
            dst_name = t["dst_name"]
            s_info = source_tensors[t["src_name"]]
            nelem = s_info["nelem"]
            src_dtype = s_info["raw_dtype"]

            if is_f32_target(dst_name):
                t["transform"] = "bf16_to_f32"
                t_raw_dtype = gguf.GGMLQuantizationType.F32
                t_nbytes = nelem * 4
            elif is_conv_weight(dst_name):
                t["transform"] = "bf16_to_f16"
                t_raw_dtype = gguf.GGMLQuantizationType.F16
                t_nbytes = nelem * 2
            else:
                t["transform"] = "verbatim"
                t_raw_dtype = gguf.GGMLQuantizationType(src_dtype)
                t_nbytes = s_info["nbytes"]

            t["target_raw_dtype"] = t_raw_dtype
            t["target_nbytes"] = t_nbytes

            writer.add_tensor_info(
                dst_name,
                tensor_shape=s_info["dims"][::-1],
                tensor_dtype=np.dtype(np.float32),
                tensor_nbytes=t_nbytes,
                raw_dtype=t_raw_dtype,
            )

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()

    with open(input_path, "rb") as in_f:
        with mmap.mmap(in_f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            for idx, t in enumerate(tensor_tasks):
                if t["kind"] == "array":
                    writer.write_tensor_data(t["array"])
                else:
                    s_info = source_tensors[t["src_name"]]
                    offset = data_start + s_info["offset"]
                    nbytes = s_info["nbytes"]
                    transform = t["transform"]

                    if transform == "verbatim":
                        chunk = np.frombuffer(mm, dtype=np.uint8, count=nbytes, offset=offset)
                        writer.write_tensor_data(chunk)
                        chunk = None
                    elif transform == "bf16_to_f32":
                        u16 = np.frombuffer(mm, dtype=np.uint16, count=s_info["nelem"], offset=offset)
                        f32 = (u16.astype(np.uint32) << 16).view(np.float32)
                        writer.write_tensor_data(f32)
                        u16 = None
                        f32 = None
                    elif transform == "bf16_to_f16":
                        u16 = np.frombuffer(mm, dtype=np.uint16, count=s_info["nelem"], offset=offset)
                        f32 = (u16.astype(np.uint32) << 16).view(np.float32)
                        f16 = f32.astype(np.float16)
                        writer.write_tensor_data(f16)
                        u16 = None
                        f32 = None
                        f16 = None

    writer.close()
    # Atomic rename to final output
    os.replace(tmp_target, output_path)


def ensure_transcribe_compatible(path: str | Path) -> str:
    """If the GGUF at path was converted for audio.cpp (general.architecture == 'audiocpp'),
    automatically remux it to a transcribe.cpp-compatible Qwen3-ASR GGUF."""
    try:
        with open(path, "rb") as f:
            magic = f.read(4)
            if magic != b"GGUF":
                return str(path)
            version = struct.unpack("<I", f.read(4))[0]
            t_cnt = struct.unpack("<Q", f.read(8))[0]
            kv_cnt = struct.unpack("<Q", f.read(8))[0]
            is_audiocpp = False
            for _ in range(kv_cnt):
                k_len = struct.unpack("<Q", f.read(8))[0]
                k = f.read(k_len).decode("utf-8", errors="replace")
                vt = struct.unpack("<I", f.read(4))[0]
                if k == "general.architecture":
                    if vt == 8:
                        val_len = struct.unpack("<Q", f.read(8))[0]
                        arch_val = f.read(val_len).decode("utf-8", errors="replace")
                        if arch_val == "audiocpp":
                            is_audiocpp = True
                    break
                else:
                    _skip_gguf_val(f, vt)
            if not is_audiocpp:
                return str(path)
    except Exception:
        return str(path)

    p = Path(path)
    target = p.with_name(f"{p.stem}-tc.gguf")
    if target.is_file() and target.stat().st_size > 100_000_000:
        return str(target)

    remux_r2t2(p, target)
    return str(target)
