# -*- coding: utf-8 -*-
"""VTFM 实时变音 worker（stdin/stdout JSON 行协议）。

适配 RVC VTFM 的 main.js：
  --list-devices   枚举音频设备，输出一行 {"ok":true,"data":{"input":[...],"output":[...],"default":[in,out]}}
  --list-presets   列出 DSP 预设，输出一行 {"ok":true,"data":[{"id":..,"name":..}]}
  --config <path>  读取配置持续运行，stdout 输出 JSON 行（type=status/ready/error/level）
                   stdin 接收 JSON 命令（{"cmd":"stop"|"key"|"formant"|"gain"|"indexRate"|"preset"}）

变音内核：
  * 默认用 dsp_voice 的 WSOLA 变调 + Formant 共振峰搬移，低延迟，A4-6300 之类也能跑；
  * 若配置里带 pthPath 且本机装了 torch，会尝试加载 RVC 声线模型做块推理（慢，但
    用户接受离线级别延迟）。加载失败自动退回 DSP 模式，不会让界面卡死。
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # C:\RVC VTFM（Tools 的上一级）
ENGINE = ROOT / "Engine"                                # 引擎目录（dsp_voice 等在这里）
for _p in (str(ENGINE), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
os.environ.setdefault("TM_REALTIME_WORKER", "1")
os.environ.setdefault("TM_WORKER_KIND", "voice")

_OUT = sys.stdout
_LOCK = threading.Lock()


def emit(obj: dict) -> None:
    """向 stdout 写一行 JSON，main.js 逐行解析。"""
    try:
        line = json.dumps(obj, ensure_ascii=False)
        with _LOCK:
            _OUT.write(line + "\n")
            _OUT.flush()
    except Exception:
        pass


# ───────────────────────── 设备枚举 ─────────────────────────

def _device_list() -> dict:
    import sounddevice as sd

    try:
        hostapis = sd.query_hostapis()
    except Exception:
        hostapis = ()
    # 低延迟优先 MME/DirectSound（Win 上 WASAPI 独占容易冲突）
    prefer = ("MME", "Windows DirectSound", "Windows WASAPI", "Windows WDM-KS")

    def api_name(dev):
        try:
            return str(hostapis[dev.get("hostapi", 0)]["name"])
        except Exception:
            return ""

    def rank_of(api):
        return prefer.index(api) if api in prefer else len(prefer)

    def norm(name):
        # MME 的设备名被 Windows 截断到 31 字符，取前 26 字符把同名设备归并到一起
        return name.strip().lower()[:26]

    # 这些是多通道虚拟设备（VB-Audio Point / 16ch），平时用不到还占位置
    block_words = ("16ch", "point")

    # 收集 → 同名只留优先级最高的那个（MME > DirectSound > WASAPI > WDM-KS）
    best_in, best_out = {}, {}
    for idx, dev in enumerate(sd.query_devices()):
        name = str(dev.get("name", "")).strip()
        if not name:
            continue
        low = name.lower()
        if any(w in low for w in block_words):
            continue
        nin = int(dev.get("max_input_channels") or 0)
        nout = int(dev.get("max_output_channels") or 0)
        # 过滤通道数异常的虚拟设备（16ch 之类，打不开还占位置）
        if nin > 8:
            nin = 0
        if nout > 8:
            nout = 0
        api = api_name(dev)
        rk = rank_of(api)
        sr = int(round(dev.get("default_samplerate") or 48000))
        key = norm(name)
        if nin > 0:
            item = {"index": idx, "name": name, "sampleRate": sr, "channels": nin, "hostapi": api}
            if key not in best_in or rk < best_in[key][0]:
                best_in[key] = (rk, item)
        if nout > 0:
            item = {"index": idx, "name": name, "sampleRate": sr, "channels": nout, "hostapi": api}
            if key not in best_out or rk < best_out[key][0]:
                best_out[key] = (rk, item)

    def sort_key(pair):
        rk, item = pair
        return (rk, 0 if "cable" in item["name"].lower() else 1, item["name"].lower())

    inputs = [it for _, it in sorted(best_in.values(), key=sort_key)]
    outputs = [it for _, it in sorted(best_out.values(), key=sort_key)]

    def def_index(kind):
        try:
            d = sd.default.device[0 if kind == "in" else 1]
            return int(d) if d is not None and d >= 0 else None
        except Exception:
            return None

    return {
        "ok": True,
        "data": {
            "input": inputs,
            "output": outputs,
            "default": [def_index("in"), def_index("out")],
            "inputCount": len(inputs),
            "outputCount": len(outputs),
        },
    }


# ───────────────────────── 预设列表 ─────────────────────────

def _preset_list() -> dict:
    out = []
    pdir = ENGINE / "configs" / "dsp_presets"
    if not pdir.is_dir():
        pdir = ROOT / "configs" / "dsp_presets"
    if pdir.is_dir():
        for p in sorted(pdir.glob("*.json")):
            name = p.stem
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("name"):
                    name = str(data["name"])
            except Exception:
                pass
            out.append({"id": p.stem, "name": name})
    if not out:
        out = [{"id": "", "name": "原声直通"}]
    return {"ok": True, "data": out}


# ───────────────────────── 变音引擎 ─────────────────────────

class VoiceEngine:
    """把输入块做变调 + 共振峰搬移，再推出输出。"""

    def __init__(self, cfg: dict) -> None:
        self.cfg = dict(cfg or {})
        self.sr = int(self.cfg.get("sampleRate") or 48000)
        self.block = int(self.cfg.get("blockSize") or 1024)
        self.gain = float(self.cfg.get("gain") if self.cfg.get("gain") is not None else 1.0)
        self.semitones = float(self.cfg.get("f0upKey") or 0.0)
        self.formant = float(self.cfg.get("formant") or 0.0)
        self.index_rate = float(self.cfg.get("indexRate") or 0.75)
        self.mode = str(self.cfg.get("mode") or "rvc")
        self.pitch = None
        self.fmt = None
        self._init_dsp()
        self.rvc = None
        self._rvc_tried = False

    # ---- DSP 内核 ----
    def _init_dsp(self) -> None:
        try:
            from tools.dsp_voice import _WsolaPitchShifter, FormantShifter
            self.pitch = _WsolaPitchShifter(self.semitones)
            self.fmt = FormantShifter(self.formant)
        except Exception:
            self.pitch = None
            self.fmt = None

    def set_key(self, value: float) -> None:
        self.semitones = float(value)
        if self.pitch is not None:
            try:
                self.pitch.semitones = self.semitones
            except Exception:
                pass

    def set_formant(self, value: float) -> None:
        self.formant = float(value)
        if self.fmt is not None:
            try:
                self.fmt.shift_semitones = self.formant
            except Exception:
                pass

    def set_gain(self, value: float) -> None:
        self.gain = max(0.0, min(4.0, float(value)))

    def _ensure_rvc(self):
        """尝试加载 RVC 模型；失败返回 None（自动退回 DSP）。"""
        if self._rvc_tried:
            return self.rvc
        self._rvc_tried = True
        pth = str(self.cfg.get("pthPath") or "")
        if not pth or not os.path.exists(pth):
            emit({"type": "log", "msg": "未提供声线模型，使用 DSP 变调模式"})
            return None
        try:
            import torch  # noqa: F401
            from infer.lib.infer_pack.models import SynthesizerTrnMs768NSFsid
            from tools.sts_core import convert_one  # noqa: F401
            # 完整 RVC 加载依赖较重，这里只做可用性探测；
            # 真正推理留给离线转换（硬件跑不动实时 RVC）。
            emit({"type": "log", "msg": "检测到 RVC 运行时，实时模式仍以 DSP 变调输出以保证延迟"})
        except Exception as exc:
            emit({"type": "log", "msg": "RVC 运行时不可用（%s），使用 DSP 变调" % str(exc)[:80]})
        return None

    def process(self, block):
        """block: numpy float32 [-1,1]，返回同长度输出。"""
        import numpy as np
        x = block
        if self.pitch is not None and abs(self.semitones) > 1e-6:
            try:
                x = self.pitch.process(x, self.sr)
            except Exception:
                pass
        if self.fmt is not None and abs(self.formant) > 1e-6:
            try:
                x = self.fmt.process(x, self.sr)
            except Exception:
                pass
        x = np.asarray(x, dtype=np.float32) * float(self.gain)
        np.clip(x, -1.0, 1.0, out=x)
        return x


def _run_config(cfg_path: str) -> int:
    try:
        cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8-sig"))
    except Exception as exc:
        emit({"type": "error", "msg": "读取配置失败：%s" % exc})
        return 2

    emit({"type": "status", "state": "loading", "msg": "正在初始化音频设备…"})

    try:
        import numpy as np
        import sounddevice as sd
    except Exception as exc:
        emit({"type": "error", "msg": "缺少 numpy/sounddevice：%s" % exc})
        return 3

    sr = int(cfg.get("sampleRate") or 48000)
    block = int(cfg.get("blockSize") or 1024)
    in_dev = cfg.get("inputDevice")
    out_dev = cfg.get("outputDevice")

    engine = VoiceEngine(cfg)
    if str(cfg.get("mode") or "rvc") != "dsp":
        engine._ensure_rvc()

    # ── RVC 声线模型：mode=rvc 时加载；mode=dsp 时不加载直接走变调 ──
    rvc_vc = None
    rvc_pitch = int(cfg.get("f0upKey") or 0)
    rvc_f0 = str(cfg.get("f0method") or "harvest")
    rvc_idx = str(cfg.get("indexPath") or "")
    rvc_idx_rate = float(cfg.get("indexRate") or 0)
    rvc_protect = float(cfg.get("protect") or 0.33)
    rvc_sr = 40000
    _mode = str(cfg.get("mode") or "rvc")
    _pth = str(cfg.get("pthPath") or "")
    if _mode == "dsp":
        emit({"type": "log", "msg": "DSP 变音模式（变调 + 共振峰，低延迟无模型噪声）"})
        emit({"type": "status", "state": "opening-audio", "msg": "正在打开音频设备…"})
        time.sleep(0.5)
    elif _pth and os.path.exists(_pth):
        try:
            emit({"type": "log", "msg": "⏳ 加载声线模型（首次约 1-2 分钟）…"})
            from dotenv import load_dotenv
            from configs.config import Config
            from infer.modules.vc.modules import VC
            from infer.lib.dml_compat import apply_for
            load_dotenv()
            _conf = Config()
            _conf.device = "cpu"
            apply_for(_conf)
            rvc_vc = VC(_conf)
            rvc_vc.get_vc(_pth)
            import gc as _gc
            _gc.collect()
            _pipe = getattr(rvc_vc, "pipeline", None)
            if _pipe is not None and hasattr(_pipe, "shrink_windows"):
                try:
                    _pipe.shrink_windows()
                    _pipe.shrink_windows()
                except Exception:
                    pass
            try:
                rvc_sr = int(getattr(rvc_vc, "tgt_sr", 0) or 40000)
            except Exception:
                rvc_sr = 40000
            emit({"type": "log", "msg": "✅ 声线模型加载完成，进入实时推理"})
            # 通知前端释放 WebAudio 麦克风，稍等片刻再开 PortAudio，避免抢设备
            emit({"type": "status", "state": "opening-audio", "msg": "正在打开音频设备…"})
            time.sleep(0.5)
        except Exception as _e:
            emit({"type": "log", "msg": "声线模型加载失败，退回 DSP 变调：%s" % str(_e)[:120]})
            rvc_vc = None

    in_q: "queue.Queue" = queue.Queue(maxsize=8)

    # ── 实时统计（供扩展面板：频谱 / 块状态 / 指标） ──
    stat = {
        "ok": 0, "fail": 0, "drop": 0, "same": 0,
        "in_rms": 0.0, "out_rms": 0.0,
        "proc_ms": 0.0,
        "pending": deque(),
        "last_lat": 0.0,
        "stability": 100.0,
    }
    _stat_lock = threading.Lock()
    spec_q: "queue.Queue" = queue.Queue(maxsize=2)

    def cb(indata, frames, time_info, status):
        try:
            blk = indata[:, 0].copy()
            try:
                if not spec_q.full():
                    spec_q.put_nowait(blk)
            except Exception:
                pass
            r = 0.0
            try:
                r = float(np.sqrt(float(np.mean(blk * blk))))
                with _stat_lock:
                    stat["in_rms"] = stat["in_rms"] * 0.7 + r * 0.3
            except Exception:
                pass
            if rvc_vc is not None:
                if rvc_infer_type == "queue":
                    # 队列分段：有声累积，静音（含完全静音）累积 silence 用于段落结束
                    if r >= SEG_VOICED:
                        seg_st["active"] = True
                        seg_st["silence"] = 0
                        seg_st["buf"].append(blk)
                        seg_st["total"] += len(blk)
                        if seg_st["total"] >= SEG_MAX:
                            _commit_seg()
                    else:
                        if seg_st["active"]:
                            seg_st["buf"].append(blk)
                            seg_st["total"] += len(blk)
                            seg_st["silence"] += len(blk)
                            if seg_st["silence"] >= SEG_END:
                                _commit_seg()
                    return
                # 实时 / 时间推理：完全静音丢弃，其余累积固定时间切分
                if r < 0.0005:
                    return
                submit = False
                with rvc_lock:
                    rvc_in_blocks.append(blk)
                    rvc_st["in_n"] += len(blk)
                    if rvc_st["in_n"] >= rvc_chunk_n:
                        chunk = np.concatenate(list(rvc_in_blocks))
                        rvc_in_blocks.clear()
                        rvc_st["in_n"] = 0
                        submit = True
                if submit:
                    seg_q.append(chunk)
                return
            # DSP 模式：完全静音丢弃
            if r < 0.0005:
                return
            if in_q.full():
                with _stat_lock:
                    stat["drop"] += 1
                    stat["pending"].append(2)
                return
            in_q.put(blk)
        except Exception:
            pass

    def pick_rate(dev, wanted):
        """设备不一定支持 wanted，退到设备默认。"""
        if dev is None:
            return wanted
        try:
            info = sd.query_devices(dev)
            dflt = int(round(info.get("default_samplerate") or wanted))
            for cand in (wanted, dflt, 44100, 48000):
                try:
                    sd.check_input_settings(device=dev, channels=1, samplerate=cand, dtype="float32")
                    return cand
                except Exception:
                    continue
        except Exception:
            pass
        return wanted

    use_sr_in = pick_rate(in_dev, sr)
    use_sr_out = pick_rate(out_dev, sr)

    # ── RVC 推理：分段 + 串行队列转换 ──
    rvc_in_blocks = deque()
    rvc_st = {"in_n": 0, "busy": 0}
    rvc_infer_type = str(cfg.get("inferType") or "queue")  # realtime / queue / time
    rvc_time_sec = float(cfg.get("timeSec") or 5)
    if rvc_infer_type == "realtime":
        rvc_chunk_n = use_sr_in  # 实时：固定 1 秒切分
    elif rvc_infer_type == "time":
        rvc_chunk_n = max(int(use_sr_in * 0.5), int(use_sr_in * rvc_time_sec))  # 时间：每 N 秒切
    else:
        rvc_chunk_n = use_sr_in  # queue 不用它，按停顿切句
    rvc_out_q = queue.Queue(maxsize=8)
    rvc_lock = threading.Lock()
    seg_q = deque()  # 待转换段落队列
    seg_st = {"buf": [], "active": False, "silence": 0, "total": 0}
    SEG_MIN = int(use_sr_in * 0.5)   # 最小段落 0.5 秒（太短的忽略，减少噪声段）
    SEG_END = int(use_sr_in * 0.6)   # 静音 0.6 秒算一句说完（按完整一句话切分）
    SEG_MAX = int(use_sr_in * 10)    # 段落最长 10 秒强制切分（音质优先，差设备等久一点）
    SEG_VOICED = 0.0015              # 有声阈值（RMS）

    def _rvc_infer(chunk):
        try:
            tmp_dir = os.path.join(str(ENGINE), "TEMP")
            os.makedirs(tmp_dir, exist_ok=True)
            tmp_in = os.path.join(tmp_dir, "_rt_in.wav")
            from scipy.io import wavfile as _wf
            _wf.write(tmp_in, use_sr_in, chunk.astype(np.float32))
            info, wav_opt = rvc_vc.vc_single(
                0, tmp_in, rvc_pitch, None, rvc_f0,
                rvc_idx, None, rvc_idx_rate, 3, 0, 1, rvc_protect,
            )
            if wav_opt and wav_opt[1] is not None:
                # vc_single 返回 (tgt_sr, audio)，wav_opt[1] 才是音频，wav_opt[0] 是采样率
                out = np.asarray(wav_opt[1], dtype=np.float32)
                out = np.atleast_1d(out)
                if out.ndim > 1:
                    out = out.mean(axis=1)
                out = out.astype(np.float32)
                out_sr = 40000
                try:
                    if len(wav_opt) > 0 and wav_opt[0]:
                        out_sr = int(wav_opt[0])
                except Exception:
                    pass
                if out_sr > 0 and int(out_sr) != int(use_sr_out):
                    try:
                        # 高质量多相重采样（避免最近邻失真导致炸麦/杂音）
                        from scipy.signal import resample_poly
                        from fractions import Fraction
                        _fr = Fraction(use_sr_out, out_sr).limit_denominator(1000)
                        out = resample_poly(out.astype(np.float64), _fr.numerator, _fr.denominator).astype(np.float32)
                    except Exception:
                        n = max(1, int(len(out) * use_sr_out / out_sr))
                        idx = np.linspace(0, len(out) - 1, n).astype(np.int64)
                        out = out[idx]
                # 去直流偏移（消除电流声/嗡嗡声）
                try:
                    out = out - float(np.mean(out))
                except Exception:
                    pass
                # 削波保护 + 段落边界淡入淡出（减少咔哒声）
                out = np.clip(out, -0.98, 0.98)
                try:
                    _fade = min(int(use_sr_out * 0.006), max(1, len(out) // 4))
                    if len(out) > _fade * 2:
                        _win = np.linspace(0, 1, _fade, dtype=np.float32)
                        out[:_fade] = out[:_fade] * _win
                        out[-_fade:] = out[-_fade:] * _win[::-1]
                except Exception:
                    pass
                with _stat_lock:
                    stat["ok"] += 1
                    stat["pending"].append(0)
                    stat["played"] = stat.get("played", 0) + len(out)
                rvc_out_q.put(out)
                try:
                    emit({"type": "log", "msg": "推理完成，输出 %.2f 秒" % (len(out) / max(1, use_sr_out))})
                except Exception:
                    pass
            else:
                with _stat_lock:
                    stat["fail"] += 1
                    stat["pending"].append(1)
        except Exception as _e:
            try:
                emit({"type": "log", "msg": "实时推理失败：%s" % str(_e)[:100]})
            except Exception:
                pass
            with _stat_lock:
                stat["fail"] += 1
                stat["pending"].append(1)

    def _commit_seg():
        if seg_st["total"] >= SEG_MIN:
            try:
                chunk = np.concatenate(seg_st["buf"])
                seg_q.append(chunk)
            except Exception:
                pass
        seg_st["buf"] = []
        seg_st["active"] = False
        seg_st["silence"] = 0
        seg_st["total"] = 0

    def _convert_loop():
        while not stop_flag.is_set():
            try:
                seg = seg_q.popleft()
            except IndexError:
                time.sleep(0.05)
                continue
            _rvc_infer(seg)

    out_ring = np.zeros(0, dtype=np.float32)

    def play_cb(outdata, frames, time_info, status):
        nonlocal out_ring
        need = frames
        if rvc_vc is not None:
            # RVC：从推理结果队列取输出（推理未跟上时输出静音）
            while len(out_ring) < need:
                try:
                    out = rvc_out_q.get_nowait()
                    out_ring = np.concatenate([out_ring, out])
                except queue.Empty:
                    break
            if len(out_ring) >= need:
                outdata[:, 0] = out_ring[:need]
                out_ring = out_ring[need:]
                with _stat_lock:
                    stat["played_out"] = stat.get("played_out", 0) + need
            else:
                if len(out_ring) > 0:
                    outdata[: len(out_ring), 0] = out_ring
                    outdata[len(out_ring):, 0] = 0.0
                    out_ring = np.zeros(0, dtype=np.float32)
                else:
                    outdata[:, 0] = 0.0
            return
        while len(out_ring) < need:
            try:
                blk = in_q.get_nowait()
            except queue.Empty:
                break
            code = 0
            proc = blk
            record = True
            try:
                rms = float(np.sqrt(float(np.mean(blk * blk))))
                if rms < 0.0005:
                    # 完全静音（麦克风未接/无输入）：不记块状态，直接透传
                    record = False
                else:
                    quiet = rms < 0.0025
                    idle = (abs(getattr(engine, "semitones", 0.0)) < 1e-6
                            and abs(getattr(engine, "formant", 0.0)) < 1e-6)
                    if quiet or idle:
                        code = 3  # 不变（环境音/无变调参数）
                    else:
                        t0 = time.perf_counter()
                        proc = engine.process(blk)
                        dt = (time.perf_counter() - t0) * 1000.0
                        with _stat_lock:
                            stat["proc_ms"] = (stat["proc_ms"] * 0.85 + dt * 0.15) if stat["proc_ms"] > 0 else dt
            except Exception:
                proc = blk
                code = 1  # 失败
            try:
                r2 = float(np.sqrt(float(np.mean(np.asarray(proc, dtype=np.float32) ** 2))))
                with _stat_lock:
                    stat["out_rms"] = stat["out_rms"] * 0.7 + r2 * 0.3
            except Exception:
                pass
            if record:
                with _stat_lock:
                    if code == 0:
                        stat["ok"] += 1
                    elif code == 1:
                        stat["fail"] += 1
                    else:
                        stat["same"] += 1
                    stat["pending"].append(code)
            out_ring = np.concatenate([out_ring, np.asarray(proc, dtype=np.float32)])
        if len(out_ring) >= need:
            outdata[:, 0] = out_ring[:need]
            out_ring = out_ring[need:]
        else:
            if len(out_ring) > 0:
                outdata[: len(out_ring), 0] = out_ring
                outdata[len(out_ring):, 0] = 0.0
                out_ring = np.zeros(0, dtype=np.float32)
            else:
                outdata[:, 0] = 0.0

    instream = None
    outstream = None
    try:
        instream = sd.InputStream(
            device=in_dev, channels=1, samplerate=use_sr_in,
            blocksize=block, dtype="float32", callback=cb,
        )
        outstream = sd.OutputStream(
            device=out_dev, channels=1, samplerate=use_sr_out,
            blocksize=block, dtype="float32", callback=play_cb,
        )
        instream.start()
        outstream.start()
    except Exception as exc:
        emit({"type": "error", "msg": "音频设备打开失败：%s" % str(exc)[:200]})
        try:
            if instream is not None:
                instream.close()
        except Exception:
            pass
        try:
            if outstream is not None:
                outstream.close()
        except Exception:
            pass
        return 4

    emit({
        "type": "ready",
        "state": "running",
        "inputRate": use_sr_in,
        "outputRate": use_sr_out,
        "blockSize": block,
        "mode": "dsp" if engine.pitch is not None else "passthrough",
        "msg": "实时变音已启动",
    })

    stop_flag = threading.Event()

    def stdin_loop():
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            cmd = str(obj.get("cmd") or "")
            if cmd == "stop":
                stop_flag.set()
                break
            if cmd == "key":
                try:
                    engine.set_key(float(obj.get("value", 0)))
                    emit({"type": "status", "state": "running", "key": engine.semitones})
                except Exception:
                    pass
            elif cmd == "formant":
                try:
                    engine.set_formant(float(obj.get("value", 0)))
                    emit({"type": "status", "state": "running", "formant": engine.formant})
                except Exception:
                    pass
            elif cmd == "gain":
                try:
                    engine.set_gain(float(obj.get("value", 1)))
                except Exception:
                    pass
            elif cmd == "indexRate":
                try:
                    engine.index_rate = float(obj.get("value", 0.75))
                except Exception:
                    pass
            elif cmd == "preset":
                emit({"type": "log", "msg": "preset=%s（实时 DSP 变调下仅记录）" % obj.get("id", "")})
            elif cmd == "priority":
                try:
                    v = int(obj.get("value", 0x20))
                    import ctypes
                    k32 = ctypes.windll.kernel32
                    k32.GetCurrentProcess.restype = ctypes.c_void_p
                    k32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
                    k32.SetPriorityClass(k32.GetCurrentProcess(), v)
                    k32.GetPriorityClass.argtypes = [ctypes.c_void_p]
                    k32.GetPriorityClass.restype = ctypes.c_uint32
                    cls = int(k32.GetPriorityClass(k32.GetCurrentProcess()))
                    emit({"type": "prio", "priority": {0x100: "实时", 0x80: "高", 0x8000: "偏高", 0x20: "正常", 0x4000: "偏低", 0x40: "低"}.get(cls, "正常")})
                except Exception:
                    pass

    t = threading.Thread(target=stdin_loop, daemon=True)
    t.start()

    # RVC 串行转换线程（队列里的段落逐个转换）
    if rvc_vc is not None:
        t_conv = threading.Thread(target=_convert_loop, daemon=True)
        t_conv.start()

    # ── 扩展面板数据线程：48 段频谱 + 块状态 + 指标，约 20Hz ──
    def spec_of(blk):
        n = int(len(blk))
        if n < 64:
            return None
        win = np.hanning(n).astype(np.float32)
        sp = np.abs(np.fft.rfft(blk.astype(np.float32) * win))
        freqs = np.fft.rfftfreq(n, 1.0 / max(1, use_sr_in))
        hi = min(12000.0, use_sr_in / 2.0 - 1.0)
        edges = np.geomspace(60.0, max(hi, 120.0), 7)  # 6 条频率线（1 主声 + 5 副声）
        bins = []
        for i in range(6):
            lo, h2 = edges[i], edges[i + 1]
            m = (freqs >= lo) & (freqs < h2)
            v = float(sp[m].max()) if m.any() else 0.0
            # 幅度 → dB → 0..100（-60dB 为 0，0dB 为 100）
            db = 20.0 * np.log10(v / max(1e-9, n * 0.5) + 1e-9)
            bins.append(max(0.0, min(100.0, (db + 60.0) / 60.0 * 100.0)))
        return bins

    def prio_name():
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            k32.GetPriorityClass.argtypes = [ctypes.c_void_p]
            k32.GetPriorityClass.restype = ctypes.c_uint32
            cls = int(k32.GetPriorityClass(k32.GetCurrentProcess()))
            return {0x100: "实时", 0x80: "高", 0x8000: "偏高", 0x20: "正常",
                    0x4000: "偏低", 0x40: "低"}.get(cls, "正常")
        except Exception:
            return "正常"

    def stat_loop():
        last_bins = [0.0] * 48
        while not stop_flag.is_set():
            time.sleep(0.05)
            try:
                blk = spec_q.get_nowait()
            except queue.Empty:
                blk = None
            if blk is not None:
                try:
                    b = spec_of(blk)
                    if b:
                        last_bins = b
                except Exception:
                    pass
            with _stat_lock:
                codes = list(stat["pending"])
                stat["pending"].clear()
                ok, fail, drop, same = stat["ok"], stat["fail"], stat["drop"], stat["same"]
                proc = stat["proc_ms"]
                cin = stat["in_rms"]
                cout = stat["out_rms"]
            total = ok + fail + same
            conv = (ok / total * 100.0) if total else 0.0
            block_ms = (block / max(1, use_sr_in)) * 1000.0
            load = min(999.0, (proc / block_ms) * 100.0) if block_ms > 0 else 0.0
            # 稳定性：按当前负面占比计算，指数平滑——后面正常会自动回正到 100
            neg = drop + fail
            alln = total + drop
            inst = 100.0 if alln <= 0 else max(0.0, 100.0 - (neg / alln) * 100.0)
            with _stat_lock:
                stat["stability"] = stat["stability"] * 0.8 + inst * 0.2
                stability = stat["stability"]
            status = "异常" if (fail > 3 and total > 0 and fail * 10 > total) else ("过载" if load > 85 else "正常")
            with _stat_lock:
                played = stat.get("played_out", 0)
            emit({
                "type": "rt-stat",
                "bins": [round(x, 1) for x in last_bins],
                "in": round(cin, 4), "out": round(cout, 4),
                "codes": codes, "ok": ok, "fail": fail, "drop": drop, "same": same,
                "lat": round(proc, 1),
                "conv": round(conv, 1),
                "load": round(load, 1),
                "stability": round(stability, 1),
                "status": status,
                "priority": prio_name(),
                "played": round(played / max(1, use_sr_out), 1),
            })

    t2 = threading.Thread(target=stat_loop, daemon=True)
    t2.start()

    # 每秒汇报一次电平，让界面有反馈
    try:
        while not stop_flag.is_set():
            time.sleep(1.0)
            emit({"type": "level", "state": "running", "ts": time.time()})
    finally:
        try:
            if instream is not None:
                instream.stop(); instream.close()
        except Exception:
            pass
        try:
            if outstream is not None:
                outstream.stop(); outstream.close()
        except Exception:
            pass
        emit({"type": "status", "state": "stopped"})
    return 0


def _run(args: list) -> int:
    if "--list-devices" in args:
        try:
            res = _device_list()
            emit(res)
            return 0
        except Exception as exc:
            emit({"ok": False, "msg": "设备枚举失败：%s" % str(exc)[:200]})
            return 1
    if "--list-presets" in args:
        emit(_preset_list())
        return 0
    if "--config" in args:
        i = args.index("--config")
        if i + 1 < len(args):
            return _run_config(args[i + 1])
        emit({"type": "error", "msg": "--config 缺少路径"})
        return 2
    emit({"ok": False, "msg": "未知参数：%s" % " ".join(args)})
    return 2


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    code = 1
    try:
        code = _run(sys.argv[1:])
    except Exception:
        emit({"type": "error", "msg": "内部错误：%s" % traceback.format_exc()[-400:]})
    raise SystemExit(code)


if __name__ == "__main__":
    main()
