# -*- coding: utf-8 -*-
"""录音测试脚本（VTFM 内嵌调用）。

用法:
    python record_test.py --seconds 3 --rate 44100 [--device N]

输出一行 JSON:
    {"ok": true, "seconds": 3.0, "rate": 44100, "base64": "...", "peaks": 0.8}
失败:
    {"ok": false, "msg": "..."}
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import wave

import numpy as np


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--rate", type=int, default=44100)
    ap.add_argument("--device", type=int, default=None)
    ap.add_argument("--channels", type=int, default=1)
    args = ap.parse_args()

    try:
        import sounddevice as sd
    except Exception as exc:
        emit({"ok": False, "msg": "缺少 sounddevice：%s" % exc})
        return 1

    seconds = max(0.5, min(30.0, float(args.seconds)))
    rate = int(args.rate)
    dev = args.device

    # 设备可能不支持请求的采样率，退到设备默认值
    try:
        if dev is not None:
            info = sd.query_devices(dev)
            dflt = int(round(info.get("default_samplerate") or rate))
            for cand in (rate, dflt, 44100, 48000):
                try:
                    sd.check_input_settings(device=dev, channels=1, samplerate=cand, dtype="float32")
                    rate = cand
                    break
                except Exception:
                    continue
    except Exception:
        pass

    frames = int(rate * seconds)
    try:
        data = sd.rec(frames, samplerate=rate, channels=1, dtype="float32", device=dev)
        sd.wait()
    except Exception as exc:
        emit({"ok": False, "msg": "录音失败：%s" % str(exc)[:200]})
        return 2

    mono = np.asarray(data, dtype=np.float32).reshape(-1)
    if mono.size == 0:
        emit({"ok": False, "msg": "没有采集到音频"})
        return 3

    peak = float(np.max(np.abs(mono)))
    pcm = np.clip(mono, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm16.tobytes())
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    emit({
        "ok": True,
        "seconds": round(mono.size / float(rate), 3),
        "rate": rate,
        "peaks": round(peak, 3),
        "base64": b64,
    })
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass
    raise SystemExit(main())
