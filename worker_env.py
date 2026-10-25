# -*- coding: utf-8 -*-
"""
RVC 转换引擎（无界面）——由 Electron 主进程拉起，stdin 收 JSON 任务，stdout 发 JSON 事件
事件: {type: log/progress/done/error, ...}
"""
import os
import sys
import json
import time
import subprocess
import threading
from pathlib import Path

# Windows 下强制 UTF-8（防止中文路径被 GBK 解码破坏，出现 Invalid \escape）
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def load_engine(fabric):
    runtime = None
    # 广场下载的运行时：Engine/runtimes/<variant>/python.exe
    rd_own = os.path.join(fabric, 'runtimes')
    if os.path.isdir(rd_own):
        for v in sorted(os.listdir(rd_own)):
            p = os.path.join(rd_own, v)
            if os.path.isfile(os.path.join(p, 'python.exe')):
                runtime = p
                break
    if runtime is None:
        rd = os.path.join(fabric, 'User_Data', 'runtimes')
        if os.path.isdir(rd):
            for v in sorted(os.listdir(rd)):
                p = os.path.join(rd, v)
                if os.path.isfile(os.path.join(p, 'python.exe')):
                    runtime = p
                    break
    if runtime is None:
        old = os.path.join(fabric, 'Runtime')
        if os.path.isfile(os.path.join(old, 'python.exe')):
            runtime = old
    if runtime is None:
        raise RuntimeError('找不到 RVC 引擎运行时')
    sys.path.insert(0, os.path.join(runtime, 'Lib', 'site-packages'))
    if fabric not in sys.path:
        sys.path.append(fabric)
    os.chdir(fabric)
    os.environ.setdefault('rmvpe_root', os.path.join(fabric, 'assets', 'rmvpe'))
    os.environ.setdefault('hubert_root', os.path.join(fabric, 'assets', 'hubert'))
    return fabric

def match_output_dir(out_root, voice_name):
    os.makedirs(out_root, exist_ok=True)
    dirs = [d for d in os.listdir(out_root) if os.path.isdir(os.path.join(out_root, d))]
    base = voice_name.replace('-中文', '').strip()
    for d in dirs:
        if d == base:
            return os.path.join(out_root, d)
    for d in dirs:
        if base.startswith(d) or d.startswith(base):
            return os.path.join(out_root, d)
    target = os.path.join(out_root, base)
    os.makedirs(target, exist_ok=True)
    return target

def main():
    raw = ''
    for line in sys.stdin:
        raw += line
    job = json.loads(raw)
    # 内存诊断
    try:
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                        ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                        ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                        ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                        ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
        ms = MEMORYSTATUSEX(); ms.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        send({'type': 'log', 'msg': '💾 当前可用内存：%.1fGB / 总 %.1fGB' % (ms.ullAvailPhys / 1073741824, ms.ullTotalPhys / 1073741824)})
        if ms.ullAvailPhys < 1.5 * 1073741824:
            send({'type': 'log', 'msg': '⚠️ 内存偏紧，建议转音时关闭其他程序（QQ/浏览器等）'})
    except Exception:
        pass
    fabric = job.get('fabric')
    try:
        fabric = load_engine(fabric)
    except Exception as e:
        send({'type': 'error', 'msg': '引擎加载失败: %s' % e})
        return

    # torch 线程数可配置：auto = 不限制；1 = 省内存；服务器 CPU 可拉高
    raw = str(job.get('torch_threads', '1') or '1')
    if raw.lower() == 'auto':
        threads = 0
    else:
        try:
            threads = int(raw)
        except Exception:
            threads = 0
        threads = max(0, min(threads, 128))
    if threads > 0:
        os.environ['OMP_NUM_THREADS'] = str(threads)
        os.environ['MKL_NUM_THREADS'] = str(threads)
        os.environ['OPENBLAS_NUM_THREADS'] = str(threads)
        try:
            import torch
            torch.set_num_threads(threads)
            torch.set_num_interop_threads(threads)
        except Exception:
            pass

    from dotenv import load_dotenv
    from configs.config import Config
    from infer.modules.vc.modules import VC
    from infer.lib.dml_compat import apply_for
    from tools.sts_core import convert_one_with_cpu_fallback, friendly_error
    from scipy.io import wavfile

    FFMPEG = os.path.join(fabric, 'ffmpeg.exe')
    TMP_WAV = os.path.join(fabric, 'TEMP', '_gui_convert.wav')
    TEMP_DIR = os.path.join(fabric, 'TEMP')
    try:
        os.makedirs(TEMP_DIR, exist_ok=True)
    except Exception:
        pass
    VIDEO_EXT = {'.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv'}

    def run_ff(args):
        return subprocess.run([FFMPEG, '-y'] + args, capture_output=True)

    def tail_err(r):
        try:
            return r.stderr.decode('utf-8', 'ignore').strip().splitlines()[-1][:200]
        except Exception:
            return ''

    try:
        send({'type': 'log', 'msg': '⏳ 加载声线模型（首次约 1-2 分钟）…'})
        load_dotenv()
        config = Config()
        config.device = job.get('device', 'cpu')
        apply_for(config)
        vc = VC(config)
        vc.get_vc(job['voice']['pth'])
        # 低内存：缩小合成窗口 + 回收垃圾，减少峰值内存
        import gc
        gc.collect()
        pipe = getattr(vc, 'pipeline', None)
        if pipe is not None and hasattr(pipe, 'shrink_windows'):
            try:
                pipe.shrink_windows()
                pipe.shrink_windows()
            except Exception:
                pass
        send({'type': 'log', 'msg': '✅ 模型加载完成'})

        files = job['files']
        out_root = job.get('output_dir')
        voice_name = job['voice']['name']
        out_dir = match_output_dir(out_root, voice_name)
        ext = job.get('output_format', 'mp3')
        pitch = int(job.get('pitch', 0))
        index_rate = float(job.get('index_rate', 0.66))
        protect = float(job.get('protect', 0.33))
        f0method = job.get('f0method', 'rmvpe') or 'rmvpe'
        ok = 0
        total = len(files)

        def do_convert(src_path):
            """把任意音频文件转成 TMP_WAV（含内存不足降级）。"""
            try:
                convert_one_with_cpu_fallback(
                    vc, Path(src_path), Path(TMP_WAV),
                    pitch=pitch, f0method=f0method,
                    index_path=job['voice'].get('idx'),
                    index_rate=index_rate, filter_radius=3,
                    resample_sr=0, rms_mix_rate=1, protect=protect,
                    on_stage=lambda *a, **k: None,
                    wavfile=wavfile, fmt='wav',
                    on_fallback=lambda e: send({'type': 'log', 'msg': '  (CPU 回退: %s)' % e}),
                )
            except Exception as e:
                msg = str(e)
                is_mem = ('memory' in msg.lower()) or ('allocate' in msg.lower())
                if is_mem and f0method != 'pm':
                    send({'type': 'log', 'msg': '⚠️ 内存不足，自动切换最省内存的音高算法 pm 重试…（建议转音时关闭其他程序）'})
                    convert_one_with_cpu_fallback(
                        vc, Path(src_path), Path(TMP_WAV),
                        pitch=pitch, f0method='pm',
                        index_path=job['voice'].get('idx'),
                        index_rate=index_rate, filter_radius=3,
                        resample_sr=0, rms_mix_rate=1, protect=protect,
                        on_stage=lambda *a, **k: None,
                        wavfile=wavfile, fmt='wav',
                        on_fallback=lambda e2: send({'type': 'log', 'msg': '  (CPU 回退: %s)' % e2}),
                    )
                else:
                    raise

        for i, src in enumerate(files):
            if not os.path.isfile(src):
                send({'type': 'progress', 'i': i, 'n': total, 'file': os.path.basename(src), 'skipped': True})
                continue
            stem = os.path.splitext(os.path.basename(src))[0]
            is_video = os.path.splitext(src)[1].lower() in VIDEO_EXT
            out_ext = 'mp4' if is_video else ext
            out_path = os.path.join(out_dir, f'{stem}_{voice_name}.{out_ext}')
            send({'type': 'progress', 'i': i, 'n': total, 'file': os.path.basename(src)})
            if os.path.exists(out_path):
                send({'type': 'log', 'msg': '⏭ 已存在，跳过：%s' % os.path.basename(out_path)})
                ok += 1
                continue
            t0 = time.time()
            tmp_video = tmp_audio = tmp_conv = None
            try:
                if is_video:
                    # ① 分离：无声视频 + 无画面音频
                    send({'type': 'log', 'msg': '🎬 分离视频：%s → 无声 MP4 + 纯音频 MP3' % os.path.basename(src)})
                    tmp_video = os.path.join(TEMP_DIR, f'_vid_{stem}.mp4')
                    tmp_audio = os.path.join(TEMP_DIR, f'_aud_{stem}.mp3')
                    rv = run_ff(['-i', src, '-an', '-c:v', 'copy', tmp_video])
                    if not (os.path.exists(tmp_video) and os.path.getsize(tmp_video) > 1024):
                        raise RuntimeError('视频提取失败：' + (tail_err(rv) or '未知错误'))
                    ra = run_ff(['-i', src, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', tmp_audio])
                    if not (os.path.exists(tmp_audio) and os.path.getsize(tmp_audio) > 1024):
                        raise RuntimeError('音频提取失败：' + (tail_err(ra) or '该视频可能没有音轨'))
                    send({'type': 'log', 'msg': '✅ 已分离：视频 %.1fMB / 音频 %.1fMB' % (
                        os.path.getsize(tmp_video) / 1048576, os.path.getsize(tmp_audio) / 1048576)})
                    convert_src = tmp_audio
                else:
                    convert_src = src

                # ② RVC 变音
                send({'type': 'log', 'msg': '🎤 转换中：%s → %s（音高算法 %s）' % (os.path.basename(src), voice_name, f0method)})
                do_convert(convert_src)

                # ③ 输出
                if is_video:
                    # 变音后的音频编码成 mp3，再和无声视频合成
                    tmp_conv = os.path.join(TEMP_DIR, f'_conv_{stem}.mp3')
                    run_ff(['-i', TMP_WAV, '-b:a', '192k', tmp_conv])
                    send({'type': 'log', 'msg': '🎞 合成中：变音音频 + 原视频画面…'})
                    rm = run_ff(['-i', tmp_video, '-i', tmp_conv,
                                 '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                                 '-map', '0:v:0', '-map', '1:a:0', '-shortest', out_path])
                    if not (os.path.exists(out_path) and os.path.getsize(out_path) > 1024):
                        raise RuntimeError('视频合成失败：' + (tail_err(rm) or '未知错误'))
                elif ext == 'wav':
                    run_ff(['-i', TMP_WAV, out_path])
                else:
                    run_ff(['-i', TMP_WAV, '-b:a', '192k', out_path])
                send({'type': 'log', 'msg': '✅ 完成（%.0f秒）：%s' % (time.time() - t0, os.path.basename(out_path))})
                ok += 1
                # 成功后清理临时文件
                for t in (tmp_video, tmp_audio, tmp_conv):
                    if t:
                        try:
                            os.remove(t)
                        except Exception:
                            pass
            except Exception as e:
                try:
                    send({'type': 'log', 'msg': '❌ 失败：%s' % friendly_error(e)})
                except Exception:
                    send({'type': 'log', 'msg': '❌ 失败：%s' % e})
        send({'type': 'done', 'ok': ok, 'total': total, 'out_dir': out_dir})
    except Exception as e:
        send({'type': 'error', 'msg': '转换出错: %s' % e})

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        send({'type': 'error', 'msg': 'worker 崩溃: %s' % e})
