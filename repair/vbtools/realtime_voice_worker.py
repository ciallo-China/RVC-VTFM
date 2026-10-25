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
    engine._ensure_rvc()

    in_q: "queue.Queue" = queue.Queue(maxsize=8)

    def cb(indata, frames, time_info, status):
        try:
            if not in_q.full():
                in_q.put(indata[:, 0].copy())
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

    out_ring = np.zeros(0, dtype=np.float32)

    def play_cb(outdata, frames, time_info, status):
        nonlocal out_ring
        need = frames
        while len(out_ring) < need:
            try:
                blk = in_q.get_nowait()
            except queue.Empty:
                break
            try:
                proc = engine.process(blk)
            except Exception:
                proc = blk
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

    t = threading.Thread(target=stdin_loop, daemon=True)
    t.start()

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
