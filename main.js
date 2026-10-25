// main.js - RVC 声线转音 主进程（便携版）
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { Readable } = require('stream');
// 允许渲染进程手动触发 V8 GC（内存优化用）
try { app.commandLine.appendSwitch('js-flags', '--expose-gc'); } catch (e) { }

// ── 便携路径：从 exe 位置向上找含 Audio-PA 的根目录（整个文件夹随便移动） ──
function findRoot() {
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'Audio-PA'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(path.dirname(process.execPath));
}
const ROOT = findRoot();                 // C:\RVC VTFM
const APPDIR = path.dirname(process.execPath); // CRVC VTFM（exe 所在）
const VOICES_DIR = path.join(ROOT, 'Voice-LP');
const INPUT_DIR = path.join(ROOT, 'Audio-PA');
const OUTPUT_DIR = path.join(ROOT, 'Audio-RL');
const SETTINGS_PATH = path.join(APPDIR, 'settings.json');

const DEFAULT_SETTINGS = {
  theme: 'pink',
  bgMode: 'white',       // white | image | video
  bgFile: '',
  bgCompress: false,   // 上传壁纸自动压缩1080P            // 自定义背景文件名（存 APPDIR/bg/ 下）
  perf: 'mid',           // low | mid | high
  particles: true,
  animations: true,
  sounds: true,
  device: 'cpu',
  enginePath: '',        // 留空 = 自动找（Engine/ 或 RVC Fabric）
  f0method: 'rmvpe',
  torch_threads: '1',
  pitch: 0,
  index_rate: 0.66,
  protect: 0.33,
  output_format: 'mp3',
};

// ── 自定义协议 rvc://（背景图片/视频、音频试听） ──
protocol.registerSchemesAsPrivileged([
  { scheme: 'rvc', privileges: { standard: true, stream: true, bypassCSP: true, supportFetchAPI: true } },
]);

function registerProtocol() {
  try {
    protocol.handle('rvc', async (req) => {
      try {
        const u = new URL(req.url);
        // rvc://bg/<file>  → APPDIR/bg/<file>
        // rvc://media/<encodedPath> → 完整路径
        if (u.host === 'bg') {
          const file = path.join(APPDIR, 'bg', decodeURIComponent(u.pathname.replace(/^\//, '')));
          if (fs.existsSync(file)) {
            const ext = path.extname(file).toLowerCase();
            const mime = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
            const st = await fs.promises.stat(file);
            const rangeH = req.headers.get('Range') || req.headers.get('range');
            if (rangeH) {
              const mm = /bytes=(\d*)-(\d*)/.exec(rangeH);
              let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
              let end = mm && mm[2] ? parseInt(mm[2], 10) : st.size - 1;
              if (isNaN(start) || start < 0) start = 0;
              if (isNaN(end) || end > st.size - 1) end = st.size - 1;
              if (start > end || start >= st.size) {
                return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + st.size } });
              }
              const len = end - start + 1;
              return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers: { 'Content-Type': mime, 'Content-Length': String(len), 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Accept-Ranges': 'bytes' } });
            }
            return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { 'Content-Type': mime, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } });
          }
        } else if (u.host === 'media') {
          const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
          if (fs.existsSync(file)) return net.fetch(require('url').pathToFileURL(file).toString());
        }
      } catch { }
      return new Response('not found', { status: 404 });
    });
  } catch { }
}

// ── 输出目录预建声线分类文件夹（爱丽丝/白子/…） ──
function ensureVoiceOutDirs(voices) {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const v of voices) {
      const base = v.name.replace('-中文', '').trim();
      fs.mkdirSync(path.join(OUTPUT_DIR, base), { recursive: true });
    }
  } catch { }
}

// ── 安装包自动清理（安装完启动后删除同目录的安装器和数据包） ──
function cleanupInstaller() {
  try {
    const candidates = [APPDIR, ROOT];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/安装包.*\.exe$/i.test(f) || /\.7z$/i.test(f)) {
          try { fs.rmSync(path.join(dir, f), { force: true }); } catch { }
        }
      }
    }
  } catch { }
}
let unpacking = null; // { kind: '引擎'|'声线包', file: 'xxx.7z' } | null

function ensureDirs() {
  for (const d of [INPUT_DIR, OUTPUT_DIR, VOICES_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { }
  }
}

// ── 引擎代码自愈 ──
// infer/tools/configs/i18n 属于 RVC 引擎的 Python 代码，广场的 runtime/engine-core 下载包都不含，
// 实体备份在 Tools\engine，Engine 里被误删时启动自动补回（只补缺失的，不覆盖已有的）。
const ENGINE_LIB_DIRS = ['infer', 'tools', 'configs', 'i18n'];
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) { try { fs.copyFileSync(s, d); } catch (e) { } }
  }
}
function ensureEngineLibs() {
  try {
    const eng = path.join(ROOT, 'Engine');
    const src = path.join(ROOT, 'Tools', 'engine');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(eng, { recursive: true });
    for (const d of ENGINE_LIB_DIRS) {
      const from = path.join(src, d);
      const to = path.join(eng, d);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try { copyDirSync(from, to); } catch (e) { }
    }
  } catch (e) { }
}

function getSevenZa() {
  const packed = path.join(process.resourcesPath, '7za.exe');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function engineReady(target) {
  // 引擎就位校验：关键文件齐全
  try {
    const rd = path.join(target, 'runtimes');
    if (!fs.existsSync(rd)) return false;
    for (const v of fs.readdirSync(rd)) {
      if (fs.existsSync(path.join(rd, v, 'python.exe'))
        && fs.existsSync(path.join(rd, v, 'Lib', 'site-packages', 'torch'))) {
        return fs.existsSync(path.join(target, 'assets', 'rmvpe'))
          && fs.existsSync(path.join(target, 'assets', 'hubert'))
          && fs.existsSync(path.join(target, 'infer'))
          && fs.existsSync(path.join(target, 'tools', 'sts_core.py'))
          && fs.existsSync(path.join(target, 'ffmpeg.exe'));
      }
    }
    return false;
  } catch { return false; }
}

function voicesReady(target) {
  try {
    for (const d of fs.readdirSync(target)) {
      const dd = path.join(target, d);
      if (!fs.statSync(dd).isDirectory()) continue;
      for (const f of fs.readdirSync(dd)) {
        if (f.toLowerCase().endsWith('.pth')) return true;
      }
    }
    return false;
  } catch { return false; }
}

function unpackNext() {
  const seven = getSevenZa();
  if (!seven) return;
  ensureDirs();
  const packs = [
    { files: ['engine.7z', '引擎包.7z'], kind: '引擎', target: path.join(ROOT, 'Engine'), ready: () => engineReady(path.join(ROOT, 'Engine')) },
    { files: ['voices.7z', '声线包.7z'], kind: '声线包', target: VOICES_DIR, ready: () => voicesReady(VOICES_DIR) },
  ];
  for (const pack of packs) {
    // 找包（支持中英文文件名）
    let src = null;
    for (const name of pack.files) {
      const p1 = path.join(APPDIR, name);
      const p2 = path.join(ROOT, name);
      if (fs.existsSync(p1)) { src = p1; break; }
      if (fs.existsSync(p2)) { src = p2; break; }
    }
    if (!src) continue; // 没这个包，跳过
    if (pack.ready()) {
      // 目标已就位但包还在 → 直接删包（内容已齐）
      try { fs.rmSync(src, { force: true }); } catch { }
      if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'unpack-done', kind: pack.kind, fast: true });
      continue;
    }
    // 需要解压
    unpacking = { kind: pack.kind, file: path.basename(src) };
    const proc = spawn(seven, ['x', '-y', '-o' + pack.target, src], { windowsHide: true });
    proc.on('exit', (code) => {
      unpacking = null;
      if (code === 0) {
        try { fs.rmSync(src, { force: true }); } catch { }
        if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'unpack-done', kind: pack.kind });
      } else {
        if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'unpack-fail', kind: pack.kind, code });
      }
      // 继续处理下一个包
      setTimeout(unpackNext, 300);
    });
    proc.on('error', (err) => {
      unpacking = null;
      if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'unpack-fail', kind: pack.kind, msg: err.message });
      setTimeout(unpackNext, 300);
    });
    break; // 一次一个（串行防内存压力），完成回调里继续下一个
  }
  // 全部处理完 → 通知刷新
  if (!unpacking) {
    cleanupInstaller(); // 装完自动删除安装程序 exe
    if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'refresh' });
  }
}

function tryUnpackPacks() {
  ensureDirs();
  unpackNext();
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8'); } catch { }
}

// ── 引擎定位（便携：优先自带的 Engine\） ──
function findPython() {
  const trace = [];
  const done = (v) => {
    trace.push('RESULT=' + (v ? (v.base + ' | ' + v.python) : 'null'));
    const logPath = path.join(ROOT, 'rvc_findpython.log');
    try { fs.writeFileSync(logPath, trace.join('\n'), 'utf8'); } catch (e) { }
    try { fs.writeFileSync(path.join(os.tmpdir(), 'rvc_findpython.log'), trace.join('\n'), 'utf8'); } catch (e) { }
    return v;
  };
  try {
    const s = loadSettings();
    trace.push('ROOT=' + ROOT);
    trace.push('enginePath=' + JSON.stringify(s.enginePath));
    const cands = [];
    if (s.enginePath) cands.push(s.enginePath);
    cands.push(path.join(ROOT, 'Engine'));
    cands.push('C:\\GAME APPS\\RVC Fabric');
    trace.push('cands=' + JSON.stringify(cands));
    for (const base of cands) {
      if (!base || !fs.existsSync(base)) { trace.push('skip(no base): ' + base); continue; }
      // 广场下载的运行时：Engine/runtimes/<variant>/python.exe
      const rdOwn = path.join(base, 'runtimes');
      trace.push('rdOwn=' + rdOwn + ' exists=' + fs.existsSync(rdOwn));
      if (fs.existsSync(rdOwn)) {
        for (const v of fs.readdirSync(rdOwn)) {
          const p = path.join(rdOwn, v, 'python.exe');
          trace.push('  check ' + p + ' = ' + fs.existsSync(p));
          if (fs.existsSync(p)) return done({ base, python: p });
        }
      }
      const rd = path.join(base, 'User_Data', 'runtimes');
      if (fs.existsSync(rd)) {
        for (const v of fs.readdirSync(rd)) {
          const p = path.join(rd, v, 'python.exe');
          if (fs.existsSync(p)) return done({ base, python: p });
        }
      }
      const old = path.join(base, 'Runtime', 'python.exe');
      trace.push('old=' + old + ' exists=' + fs.existsSync(old));
      if (fs.existsSync(old)) return done({ base, python: old });
    }
    return done(null);
  } catch (err) {
    trace.push('EXCEPTION=' + ((err && err.message) || err));
    return done(null);
  }
}
function engineInfo() {
  const e = findPython();
  return e ? { base: e.base, python: e.python, ok: true } : { base: '', python: '', ok: false };
}

function scanVoices() {
  const out = [];
  if (!fs.existsSync(VOICES_DIR)) return out;
  for (const name of fs.readdirSync(VOICES_DIR)) {
    const d = path.join(VOICES_DIR, name);
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    let pth = null, idx = null, cover = null, onlineId = '';
    for (const f of fs.readdirSync(d)) {
      if (f.toLowerCase().endsWith('.pth')) pth = path.join(d, f);
      else if (f.toLowerCase().endsWith('.index')) idx = path.join(d, f);
      else if (/\.(png|jpe?g|webp)$/i.test(f)) cover = cover || path.join(d, f); // 任意常用图片作为立绘
    }
    // 读 config.json 的 online_id（日配判定用：Hoshino-JP / Hina-ZH）
    try {
      const cj = path.join(d, 'config.json');
      if (fs.existsSync(cj)) {
        const c = JSON.parse(fs.readFileSync(cj, 'utf8'));
        onlineId = String((c && c.online_id) || '');
      }
    } catch (e) { }
    if (pth) out.push({ name, pth, idx, cover, onlineId });
  }
  return out;
}

let win = null;
let worker = null;

// ── worker 任务启动（桌面/手机共用） ──
function startWorkerJob(job, onEvent, onExit) {
  try {
    const eng = engineInfo();
    if (!eng.ok || !eng.python || typeof eng.python !== 'string') {
      onExit({ error: '找不到 RVC 引擎（未定位到 python.exe，请检查 Engine\\runtimes）' });
      return false;
    }
    if (worker) return false; // 忙
    const resDir = process.resourcesPath || path.dirname(process.execPath);
    const packed = path.join(resDir, 'worker_env.py');
    const dev = path.join(__dirname, 'worker_env.py');
    const pyScript = fs.existsSync(packed) ? packed : dev;
    if (!pyScript || typeof pyScript !== 'string' || !fs.existsSync(pyScript)) {
      onExit({ error: '缺少 worker_env.py（resources 与 app.asar 内都没找到）' });
      return false;
    }
    worker = spawn(eng.python, [pyScript], {
      cwd: eng.base, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let buf = '';
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); onEvent(m); }
        catch { onEvent({ type: 'raw', msg: line }); }
      }
    });
    worker.stderr.on('data', (d) => { onEvent({ type: 'raw', msg: String(d) }); });
    worker.on('exit', (code) => { worker = null; onExit({ code }); });
    worker.on('error', (err) => { worker = null; onExit({ code: -1, msg: err.message }); });
    const payload = JSON.stringify({ ...job, fabric: eng.base, output_dir: OUTPUT_DIR, input_dir: INPUT_DIR });
    worker.stdin.setDefaultEncoding('utf8');
    worker.stdin.write(Buffer.from(payload + '\n', 'utf8'));
    worker.stdin.end();
    return true;
  } catch (err) {
    worker = null;
    onExit({ error: '启动引擎失败：' + ((err && err.message) || err) });
    return false;
  }
}

// ── 手机模式：局域网 HTTP 服务 ──
const MOBILE_PORT = 7860;
let mobileServer = null;
const mobileJobs = new Map();
let mobileSeq = 0;

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function startMobileServer() {
  if (mobileServer) return;
  const uploadDir = path.join(APPDIR, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const checkAuth = (url) => {
    const token = loadSettings().mobileToken || '';
    if (!token) return true; // 没设密码 = 开放（局域网默认）
    return url.searchParams.get('t') === token;
  };
  mobileServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // 密码验证接口
      if (url.pathname === '/api/auth' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const j = JSON.parse(body);
            const token = loadSettings().mobileToken || '';
            if (token && j.token === token) sendJson(res, { ok: true });
            else if (!token) sendJson(res, { ok: true });
            else sendJson(res, { ok: false }, 401);
          } catch { sendJson(res, { ok: false }, 400); }
        });
        return;
      }
      if (url.pathname === '/' ) {
        // 手机页面（asar 内）
        const htmlPath = path.join(__dirname, 'mobile.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        html = html.replace('__LAN_IP__', getLanIp()).replace('__PORT__', String(MOBILE_PORT));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      // 其余 API 都要密码（设置了密码时）
      if (!checkAuth(url)) { sendJson(res, { error: '需要访问密码' }, 401); return; }
      if (url.pathname === '/api/voices') {
        sendJson(res, { voices: scanVoices().map((v) => ({ name: v.name })) });
        return;
      }
      if (url.pathname === '/api/convert' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 60 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const j = JSON.parse(body);
            const ext = (j.ext || 'mp3').replace(/[^a-z0-9]/gi, '');
            const id = 'm' + (++mobileSeq) + '_' + Date.now();
            const upPath = path.join(uploadDir, id + '.' + ext);
            fs.writeFileSync(upPath, Buffer.from(j.audio || '', 'base64'));
            const voice = scanVoices().find((v) => v.name === j.voiceName);
            if (!voice) { sendJson(res, { error: '声线不存在' }, 400); return; }
            const job = {
              files: [upPath],
              voice: { name: voice.name, pth: voice.pth, idx: voice.idx },
              pitch: j.pitch || 0, index_rate: j.index_rate || 0.66, protect: j.protect || 0.33,
              output_format: 'mp3', device: loadSettings().device || 'cpu',
              f0method: j.f0method || loadSettings().f0method || 'rmvpe',
            };
            const st = { id, status: 'queued', outPath: null, logs: [] };
            const isVid = /^(mp4|mov|mkv|avi|webm|m4v|flv|wmv)$/i.test(ext);
            const outExt = isVid ? 'mp4' : 'mp3';
            mobileJobs.set(id, st);
            const ok = startWorkerJob(job,
              (m) => {
                if (m.type === 'log') st.logs.push(m.msg);
                if (m.type === 'done') { st.status = 'done'; st.outPath = m.out_dir ? path.join(m.out_dir, path.basename(upPath, path.extname(upPath)) + '_' + voice.name + '.' + outExt) : null; }
                if (m.type === 'error') { st.status = 'error'; st.logs.push(m.msg); }
              },
              (r) => { if (st.status === 'queued' || st.status === 'running') { st.status = r.error ? 'error' : (r.code === 0 ? 'done' : 'error'); } }
            );
            if (!ok) { fs.rmSync(upPath, { force: true }); sendJson(res, { error: '引擎忙，请稍后再试' }, 409); return; }
            st.status = 'running';
            sendJson(res, { id });
          } catch (e) { sendJson(res, { error: e.message }, 400); }
        });
        return;
      }
      if (url.pathname.startsWith('/api/status/')) {
        const id = url.pathname.split('/').pop();
        const st = mobileJobs.get(id);
        sendJson(res, st ? { status: st.status, logs: st.logs.slice(-8) } : { status: 'notfound' });
        return;
      }
      if (url.pathname.startsWith('/api/result/')) {
        const id = url.pathname.split('/').pop();
        const st = mobileJobs.get(id);
        if (st && st.outPath && fs.existsSync(st.outPath)) {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(st.outPath)) });
          fs.createReadStream(st.outPath).pipe(res);
          return;
        }
        sendJson(res, { error: '结果不存在' }, 404);
        return;
      }
      sendJson(res, { error: 'not found' }, 404);
    } catch (e) { sendJson(res, { error: e.message }, 500); }
  });
  mobileServer.listen(MOBILE_PORT, '0.0.0.0');
}

function stopMobileServer() {
  if (mobileServer) { try { mobileServer.close(); } catch { } mobileServer = null; }
}

ipcMain.handle('mobile-server', (e, on) => {
  if (on) { startMobileServer(); return { ok: true, url: `http://${getLanIp()}:${MOBILE_PORT}` }; }
  stopMobileServer();
  return { ok: true };
});

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 940, minHeight: 640,
    title: 'RVC 声线转音',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'app.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; if (worker) { try { worker.kill(); } catch { } } });
}

app.whenReady().then(() => {
  registerProtocol();
  ensureDirs();
  try { ensureEngineLibs(); } catch (e) { }
  createWindow();
  win.webContents.once('did-finish-load', () => { setTimeout(tryUnpackPacks, 1200); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { try { if (rtProc) rtProc.kill(); } catch (e) { } });

app.on('window-all-closed', () => { app.quit(); });

// ── IPC ──
ipcMain.handle('get-state', () => {
  const e = engineInfo();
  const voices = scanVoices();
  ensureVoiceOutDirs(voices); // 预建 Audio-RL 下的声线分类文件夹
  return {
    settings: loadSettings(),
    voices,
    engineOk: e.ok,
    engineBase: e.base,
    inputDir: INPUT_DIR,
    outputDir: OUTPUT_DIR,
    voicesDir: VOICES_DIR,
    engineDir: path.join(ROOT, 'Engine'),
    root: ROOT,
    appDir: APPDIR,
    unpacking: unpacking,
  };
});

ipcMain.handle('save-settings', (e, patch) => {
  saveSettings({ ...loadSettings(), ...patch });
  return loadSettings();
});

// 录音（只存内存 base64 返回渲染进程，不写磁盘）
ipcMain.handle('record-input', (e, opts) => {
  return new Promise((resolve) => {
    const py = (findPython() || {}).python || '';
    if (!py) { resolve({ ok: false, msg: '找不到 Python 运行时' }); return; }
    const script = path.join(ROOT, 'Tools', 'record_test.py');
    if (!fs.existsSync(script)) { resolve({ ok: false, msg: '缺少录音脚本 Tools/record_test.py' }); return; }
    const args = [script, '--seconds', String((opts && opts.seconds) || 3), '--rate', String((opts && opts.rate) || 44100)];
    if (opts && opts.device != null) args.push('--device', String(opts.device));
    const ps = spawn(py, args, { cwd: path.join(ROOT, 'Engine'), windowsHide: true });
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { try { ps.kill(); } catch (e2) { } finish({ ok: false, msg: '录音超时' }); }, 20000);
    ps.stdout.on('data', (c) => { out += c.toString('utf8'); });
    ps.stderr.on('data', (c) => { out += c.toString('utf8'); });
    ps.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) { finish({ ok: false, msg: '录音没有返回数据' }); return; }
      try { finish(JSON.parse(line)); } catch (e) { finish({ ok: false, msg: '返回解析失败' }); }
    });
    ps.on('error', (err) => { clearTimeout(timer); finish({ ok: false, msg: err.message }); });
  });
});

// 语言切换：保存后自动重启软件生效
ipcMain.handle('relaunch-app', () => {
  setTimeout(() => { try { app.relaunch(); app.exit(0); } catch (e) { } }, 300);
  return { ok: true };
});

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音频', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音视频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }, { name: '全部', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择文件夹', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择背景图片', properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择背景视频', properties: ['openFile'],
    filters: [{ name: '视频', extensions: ['mp4', 'webm'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 背景文件：复制到 APPDIR/bg/ 并记录
ipcMain.handle('set-background', async (e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, msg: '文件不存在' };
    const bgDir = path.join(APPDIR, 'bg');
    fs.mkdirSync(bgDir, { recursive: true });
    const ext = path.extname(p).toLowerCase();
      const isVideo = /\.(mp4|webm)$/i.test(ext);
      const base0 = path.basename(p, ext);
      let base = base0 + ext;
      let compressed = false;
      if (isVideo) {
        base = base0 + '.mp4';
        const dst2 = path.join(bgDir, base);
        if (fs.existsSync(dst2)) { try { fs.unlinkSync(dst2); } catch (e) { } }
        const ff = path.join(ROOT, 'Engine', 'ffmpeg.exe');
        const st0 = loadSettings();
        if (st0.bgCompress && fs.existsSync(ff)) {
          const vfArgs = ['-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"];
          const tryEnc = (encArgs) => new Promise((res, rej) => {
            const ps = spawn(ff, ['-y', '-i', p, ...vfArgs, ...encArgs, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dst2], { windowsHide: true });
            ps.on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg 退出码 ' + c))));
            ps.on('error', rej);
          });
          let done = false;
          try { await tryEnc(['-c:v', 'h264_mf', '-b:v', '4000k']); done = true; } catch (e1) { }
          if (!done) { try { await tryEnc(['-c:v', 'mpeg4', '-q:v', '5']); done = true; } catch (e2) { } }
          if (!done) { try { fs.copyFileSync(p, dst2); done = true; } catch (e3) { } }
          compressed = done;
        } else { fs.copyFileSync(p, dst2); }
      } else {
        const img = require('electron').nativeImage.createFromPath(p);
        const sz = img.getSize();
        const st1 = loadSettings();
        if (st1.bgCompress && !img.isEmpty() && (sz.width > 1920 || sz.height > 1080)) {
          base = base0 + '.jpg';
          const ratio = Math.min(1920 / sz.width, 1080 / sz.height);
          const small = img.resize({ width: Math.max(1, Math.round(sz.width * ratio)), height: Math.max(1, Math.round(sz.height * ratio)), quality: 'good' });
          const dst2 = path.join(bgDir, base);
          if (fs.existsSync(dst2)) { try { fs.unlinkSync(dst2); } catch (e) { } }
          fs.writeFileSync(dst2, small.toJPEG(88));
          compressed = true;
        } else {
          const dst2 = path.join(bgDir, base);
          if (fs.existsSync(dst2)) { try { fs.unlinkSync(dst2); } catch (e) { } }
          fs.copyFileSync(p, dst2);
        }
      }
      
    const s = loadSettings();
      s.bgFile = base;
      s.bgMode = isVideo ? 'video' : 'image';
      saveSettings(s);
      return { ok: true, bgFile: s.bgFile, bgMode: s.bgMode, compressed: compressed };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('clear-background', () => {
  const s = loadSettings();
  s.bgMode = 'white'; s.bgFile = '';
  saveSettings(s);
  return { ok: true };
});

  // 保存的壁纸：列表 / 删除
  ipcMain.handle('list-bg', () => {
    try {
      const bgDir = path.join(APPDIR, 'bg');
      if (!fs.existsSync(bgDir)) return [];
      try {
        const tr = path.join(bgDir, '_trash');
        if (fs.existsSync(tr)) {
          for (const tf of fs.readdirSync(tr)) {
            try { fs.unlinkSync(path.join(tr, tf)); } catch (e) { }
          }
        }
      } catch (e) { }
      return fs.readdirSync(bgDir)
        .filter((f) => /\.(png|jpg|jpeg|webp|mp4|webm)$/i.test(f))
        .map((f) => { const full = path.join(bgDir, f); try { return { name: f, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs }; } catch (e) { return null; } })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    } catch (err) { return []; }
  });
  ipcMain.handle('rename-bg', (e, oldName, newName) => {
    try {
      if (!oldName || !newName || !/^[\w.\u4e00-\u9fa5\-\s]+$/.test(newName)) return { ok: false, msg: '名字只能包含字母数字中文和 - _ 空格，且要保留扩展名' };
      const bgDir = path.join(APPDIR, 'bg');
      const a = path.join(bgDir, oldName), b = path.join(bgDir, newName);
      if (!fs.existsSync(a)) return { ok: false, msg: '原文件不存在' };
      if (path.extname(a).toLowerCase() !== path.extname(b).toLowerCase()) return { ok: false, msg: '扩展名不能变' };
      if (fs.existsSync(b)) return { ok: false, msg: '这个名字已存在' };
      fs.renameSync(a, b);
      const s = loadSettings();
      if (s.bgFile === oldName) { s.bgFile = newName; saveSettings(s); }
      return { ok: true };
    } catch (err) { return { ok: false, msg: err.message }; }
  });
  ipcMain.handle('delete-bg', (e, name) => {
    try {
      if (!name || /[\\/]/.test(name) || name.indexOf('..') >= 0 || /^\s*$/.test(name)) return { ok: false, msg: '非法文件名' };
      const bgDir = path.join(APPDIR, 'bg');
      const f = path.join(bgDir, name);
      let warn = '';
      if (fs.existsSync(f)) {
        const trash = path.join(bgDir, '_trash');
        try { fs.mkdirSync(trash, { recursive: true }); } catch (e0) { }
        try {
          fs.renameSync(f, path.join(trash, Date.now() + '_' + name));
        } catch (e1) {
          try { fs.unlinkSync(f); } catch (e2) { warn = '文件被播放器占用，已从列表移除，重启软件后可彻底删除'; }
        }
        // 移动成功后立即真正删除 _trash 里的全部文件（删不掉的留到下次）
        try {
          for (const tf of fs.readdirSync(trash)) {
            try { fs.unlinkSync(path.join(trash, tf)); } catch (e3) { }
          }
        } catch (e4) { }
      }
      const s = loadSettings();
      if (s.bgFile === name) { s.bgFile = ''; s.bgMode = 'white'; saveSettings(s); }
      return { ok: true, warn: warn };
    } catch (err) { return { ok: false, msg: err.message }; }
  });

ipcMain.handle('get-cover', (e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return null;
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + fs.readFileSync(p).toString('base64');
  } catch { return null; }
});

// 安装声线包：源文件夹 → Voice-LP
ipcMain.handle('install-voice-pack', (e, src) => {
  try {
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: false, msg: '源文件夹无效' };
    const name = path.basename(src);
    const dst = path.join(VOICES_DIR, name);
    if (fs.existsSync(dst)) return { ok: false, msg: 'Voice-LP 里已有同名文件夹「' + name + '」，请先移除旧的' };
    fs.cpSync(src, dst, { recursive: true });
    const v = scanVoices().find((x) => x.name === name);
    if (!v) { try { fs.rmSync(dst, { recursive: true }); } catch { } return { ok: false, msg: '文件夹里没有找到 .pth 模型文件' }; }
    return { ok: true, name, cover: v.cover };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('open-folder', (e, p) => { if (p && fs.existsSync(p)) shell.openPath(p); });

ipcMain.handle('clear-input', () => {
  try {
    if (fs.existsSync(INPUT_DIR)) {
      for (const f of fs.readdirSync(INPUT_DIR)) {
        fs.rmSync(path.join(INPUT_DIR, f), { recursive: true, force: true });
      }
    }
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('get-input-files', () => {
  if (!fs.existsSync(INPUT_DIR)) return { files: [] };
  const exts = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'];
  return {
    files: fs.readdirSync(INPUT_DIR)
      .filter((f) => exts.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(INPUT_DIR, f)),
  };
});

ipcMain.handle('start-convert', async (e, job) => {
  let lastErr = '';
  const ok = startWorkerJob(job,
    (m) => { if (win && !win.isDestroyed()) win.webContents.send('worker-event', m); },
    (r) => { if (r && r.error) lastErr = r.error; if (win && !win.isDestroyed()) win.webContents.send('worker-event', { type: 'exit', ...r }); }
  );
  if (!ok) {
    if (worker) return { error: '已有转换任务进行中' };
    let diag = '';
    try {
      const ei = engineInfo();
      diag = '［根目录=' + ROOT + '，引擎=' + (ei.base || '无') + '，python=' + (ei.python || '无') + '］';
    } catch (e2) { diag = '［定位异常：' + ((e2 && e2.message) || e2) + '］'; }
    return { error: (lastErr || '找不到 RVC 引擎') + diag + ' 请确认 Engine\\runtimes\\<变体>\\python.exe 存在' };
  }
  return { started: true };
});

ipcMain.handle('stop-convert', () => {
  if (worker) { try { worker.kill(); } catch { } worker = null; }
  return true;
});

// ── 系统状态监控：内存 / 处理器 / 硬盘占用率（每 2 秒推给渲染进程）──
let sysTimer = null;
let diskProc = null;
let diskPercent = 0;
let prevCpu = null;

function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  if (!prevCpu) { prevCpu = { idle, total }; return 0; }
  const di = idle - prevCpu.idle, dt = total - prevCpu.total;
  prevCpu = { idle, total };
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

function startDiskSampler() {
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'typeperf.exe');
    diskProc = spawn(exe, ['\\PhysicalDisk(_Total)\\% Disk Time', '-si', '2'], { windowsHide: true });
    diskProc.stdout.on('data', (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const m = line.match(/"([^"]*)"\s*$/);
        if (!m) continue;
        const v = parseFloat(m[1]);
        if (!isNaN(v)) diskPercent = Math.max(0, Math.min(100, v));
      }
    });
    diskProc.on('error', () => { diskProc = null; });
    diskProc.on('exit', () => { diskProc = null; });
  } catch (e) { diskProc = null; }
}

function pushSysStats() {
  if (!win || win.isDestroyed()) return;
  const total = os.totalmem(), free = os.freemem();
  win.webContents.send('sys-stats', {
    ramUsed: (total - free) / 1073741824,
    ramTotal: total / 1073741824,
    cpu: cpuPercent(),
    disk: diskPercent,
  });
}

app.whenReady().then(() => {
  setTimeout(() => {
    pushSysStats();
    startDiskSampler();
    sysTimer = setInterval(pushSysStats, 2000);
  }, 1500);
  // 性能守护：把本应用所有进程设为高优先级（启动后 6 秒 + 每 60 秒补设）
  const boostPs = "$ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.Path -like '*RVC VTFM*' } | ForEach-Object { try { $_.PriorityClass = 'High' } catch { } }";
  const boostB64 = Buffer.from(boostPs, 'utf16le').toString('base64');
  const boost = () => {
    try {
      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', boostB64], { windowsHide: true });
      ps.on('error', () => { });
    } catch (e) { }
  };
  setTimeout(boost, 6000);
  setInterval(boost, 60000);
});
app.on('will-quit', () => {
  try { if (sysTimer) clearInterval(sysTimer); } catch (e) { }
  try { if (diskProc) diskProc.kill(); } catch (e) { }
});

// ── 更多面板：内存优化（清理全部进程工作集 + 触发 V8 GC，效果对齐 PCL2）──
// koffi（Node 直连 WinAPI，无外部进程）
let _koffi = null;
function getKoffi() {
  if (_koffi !== null) return _koffi;
  try {
    _koffi = require(path.join(APPDIR, 'node_modules', 'koffi'));
    const k32 = _koffi.load('kernel32.dll');
    const psapi = _koffi.load('psapi.dll');
    const advapi = _koffi.load('advapi32.dll');
    const ntdll = _koffi.load('ntdll.dll');
    _koffi.api = {
      OpenProcess: k32.func('void* OpenProcess(uint32_t acc, bool inh, uint32_t pid)'),
      CloseHandle: k32.func('bool CloseHandle(void* h)'),
      SetProcessWorkingSetSize: k32.func('bool SetProcessWorkingSetSize(void* h, intptr_t min, intptr_t max)'),
      EmptyWorkingSet: psapi.func('bool EmptyWorkingSet(void* h)'),
      EnumProcesses: psapi.func('bool EnumProcesses(uint32_t *pProcessIds, uint32_t cb, uint32_t *pBytesReturned)'),
      GetCurrentProcess: k32.func('void* GetCurrentProcess()'),
      OpenProcessToken: advapi.func('bool OpenProcessToken(void* h, uint32_t acc, void** tok)'),
      LookupPrivilegeValueW: advapi.func('bool LookupPrivilegeValueW(void* host, uint16_t* name, void* luid)'),
      AdjustTokenPrivileges: advapi.func('bool AdjustTokenPrivileges(void* tok, bool dis, void* np, uint32_t len, void* prev, void* rl)'),
      NtSetSystemInformation: ntdll.func('int32_t NtSetSystemInformation(int32_t cls, void* info, uint32_t len)'),
      SetSystemFileCacheSize: k32.func('bool SetSystemFileCacheSize(intptr_t min, intptr_t max, uint32_t flags)'),
    };
    // 提权 + 清待机列表 / 系统文件缓存（管理员运行时才有大效果，老版本 PowerShell 同款）
    _koffi.purge = () => {
      const a = _koffi.api;
      const enablePriv = (name) => {
        try {
          const h = a.GetCurrentProcess();
          const tokPtr = [null];
          if (!a.OpenProcessToken(h, 0x28, tokPtr) || !tokPtr[0]) return false;
          const luid = Buffer.alloc(8);
          const nameBuf = Buffer.from(name + '\0', 'utf16le');
          if (!a.LookupPrivilegeValueW(null, nameBuf, luid)) return false;
          const tp = Buffer.alloc(12);
          tp.writeUInt32LE(1, 0);
          luid.copy(tp, 4);
          tp.writeUInt32LE(2, 8); // SE_PRIVILEGE_ENABLED
          return !!a.AdjustTokenPrivileges(tokPtr[0], false, tp, 12, null, null);
        } catch (e) { return false; }
      };
      try {
        enablePriv('SeProfileSingleProcessPrivilege');
        for (const cmd of [4, 3, 2, 5]) {
          try {
            const p = Buffer.alloc(4);
            p.writeInt32LE(cmd, 0);
            a.NtSetSystemInformation(80, p, 4);
          } catch (e) { }
        }
        try {
          if (enablePriv('SeIncreaseQuotaPrivilege')) a.SetSystemFileCacheSize(-1, -1, 0);
        } catch (e) { }
        return true;
      } catch (e) { return false; }
    };
  } catch (e) {
    _koffi = false;
  }
  return _koffi;
}

ipcMain.handle('optimize-memory', async () => {
  const sumWS = () => {
    try {
      return app.getAppMetrics().reduce((s, m) => s + (m.memory && m.memory.workingSetSize || 0), 0);
    } catch (e) { return 0; }
  };
  // 1) 先让渲染进程和主进程做 V8 GC，释放可回收对象
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('gc-now'); } catch (e) { }
    try {
      win.webContents.executeJavaScript(
        'try { if (typeof gc === "function") { gc(); setTimeout(() => { try { gc(); } catch (e) { } }, 200); setTimeout(() => { try { gc(); } catch (e) { } }, 500); } } catch (e) { }'
      ).catch(() => { });
    } catch (e) { }
  }
  try { if (typeof global.gc === 'function') { global.gc(); setTimeout(() => { try { global.gc(); } catch (e) { } }, 400); } } catch (e) { }
  await new Promise((r) => setTimeout(r, 1800));
  // 2) koffi 压缩工作集：先 RVC 自身进程，再全系统进程（全系统才能清出大数字）
  const before = sumWS();
  const freeBeforeMB = Math.round(os.freemem() / 1048576);
  let trimmed = 0, total = 0;
  const k = getKoffi();
  if (k && k.api) {
    const trimPid = (pid) => {
      total++;
      try {
        const h = k.api.OpenProcess(0x1F0FFF, false, pid);
        if (!h) return false;
        k.api.SetProcessWorkingSetSize(h, -1, -1);
        const ok = k.api.EmptyWorkingSet(h);
        k.api.CloseHandle(h);
        if (ok) trimmed++;
        return ok;
      } catch (e) { return false; }
    };
    // RVC 自身进程优先
    let ownPids = [];
    try { ownPids = app.getAppMetrics().map((m) => m.pid); } catch (e) { }
    ownPids.push(process.pid);
    for (const pid of ownPids) trimPid(pid);
    // 全系统进程（枚举所有 pid）
    try {
      const buf = Buffer.alloc(4096 * 4);
      const ret = Buffer.alloc(4);
      if (k.api.EnumProcesses(buf, buf.length, ret)) {
        const used = Math.min(4096, ret.readUInt32LE(0) / 4);
        const own = new Set(ownPids);
        for (let i = 0; i < used; i++) {
          const pid = buf.readUInt32LE(i * 4);
          if (!pid || own.has(pid)) continue;
          trimPid(pid);
        }
      }
    } catch (e) { }
    // 3) 不再清「待机列表 + 系统文件缓存」——那会让可用内存暴涨后又暴跌（Windows 会立刻重新缓存文件），
    //    造成"优化后不到 10 秒内存掉回去"的假象。只做进程工作集压缩（EmptyWorkingSet），
    //    效果虽温和但稳定，与 PCL2 行为一致。
  }
  await new Promise((r) => setTimeout(r, 400));
  const after = sumWS();
  const freeAfterMB = Math.round(os.freemem() / 1048576);
  const rvcFreed = Math.max(0, Math.round((before - after) / 1024));
  // 全系统清理后物理内存真正回涨，取两者较大值作为"清理效果"
  const sysFreed = Math.max(0, freeAfterMB - freeBeforeMB);
  const freedMB = Math.max(rvcFreed, sysFreed);
  const wsOk = k && k.api ? (trimmed + '/' + total) : 'koffi 不可用';
  const cleaned = 'RVC ' + Math.round(before / 1024) + 'MB→' + Math.round(after / 1024) + 'MB｜系统可用 ' + freeBeforeMB + 'MB→' + freeAfterMB + 'MB';
  return { ok: true, freedMB, freeMB: freeAfterMB, totalMB: Math.round(os.totalmem() / 1048576), cleaned, priv: null, rc: null, wsOk };
});

// ── 更多面板：多线程分段下载 ──
let dlState = null;
function pickName(url, cd) {
  try {
    if (cd) {
      const m1 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (m1) return decodeURIComponent(m1[1].trim().replace(/"/g, ''));
      const m2 = /filename="?([^";]+)"?/i.exec(cd);
      if (m2) return m2[1].trim();
    }
  } catch (e) { }
  try {
    const base = decodeURIComponent((url.split('?')[0].split('#')[0]).split('/').pop() || '');
    if (base && /\./.test(base)) return base;
  } catch (e) { }
  return '';
}
function probe(url, depth) {
  depth = depth || 0;
  return new Promise((resolve) => {
    if (depth > 5) { resolve({ total: 0, ranges: false, code: 0, finalUrl: url, filename: '' }); return; }
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.request(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RVC/1.0', Accept: '*/*' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = '';
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { next = res.headers.location; }
        resolve(probe(next, depth + 1));
        return;
      }
      const cr = res.headers['content-range'] || '';
      let total = 0, ranges = false;
      const mm = /\/(\d+)\s*$/.exec(cr);
      if (res.statusCode === 206 && mm) { total = parseInt(mm[1], 10); ranges = true; }
      else if (res.statusCode === 200 && res.headers['content-length']) total = parseInt(res.headers['content-length'], 10);
      const filename = pickName(url, res.headers['content-disposition']);
      res.resume();
      resolve({ total: total || 0, ranges, code: res.statusCode, finalUrl: url, filename });
    });
    req.on('error', () => headProbe(url).then(resolve));
    req.on('timeout', () => { req.destroy(); headProbe(url).then(resolve); });
    req.end();
  });
}
function headProbe(url, depth) {
  depth = depth || 0;
  return new Promise((resolve) => {
    if (depth > 5) { resolve({ total: 0, ranges: false, code: 0, finalUrl: url, filename: '', unknown: true }); return; }
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.request(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RVC/1.0', Accept: '*/*' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = '';
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { next = res.headers.location; }
        resolve(headProbe(next, depth + 1));
        return;
      }
      const cl = parseInt(res.headers['content-length'] || '0', 10);
      res.resume();
      if (res.statusCode === 200 && cl > 0) resolve({ total: cl, ranges: false, code: 200, finalUrl: url, filename: '', unknown: false });
      else resolve({ total: 0, ranges: false, code: res.statusCode, finalUrl: url, filename: '', unknown: true });
    });
    req.on('error', () => resolve({ total: 0, ranges: false, code: 0, finalUrl: url, filename: '', unknown: true }));
    req.on('timeout', () => { req.destroy(); resolve({ total: 0, ranges: false, code: 0, finalUrl: url, filename: '', unknown: true }); });
    req.end();
  });
}
function fetchWhole(url, file, onBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.request(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RVC-Mobile/1.0', Accept: '*/*' }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = '';
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { next = res.headers.location; }
        resolve(fetchWhole(next, file, onBytes));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const ws = fs.createWriteStream(file);
      res.on('data', () => {});
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    req.end();
  });
}
function fetchRange(url, start, end, file, onBytes, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('重定向过多')); return; }
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.request(url, {
      headers: { Range: 'bytes=' + start + '-' + end, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RVC/1.0', Accept: '*/*' },
      timeout: 120000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = '';
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { next = res.headers.location; }
        resolve(fetchRange(next, start, end, file, onBytes, depth + 1));
        return;
      }
      if (res.statusCode !== 206) { res.resume(); reject(new Error('HTTP ' + res.statusCode + '（服务器未按分段返回）')); return; }
      const ws = fs.createWriteStream(file);
      // 数据看门狗：30 秒一个字节都没收到就断开重试，避免连接卡死拖死整批
      let last = Date.now();
      const guard = setInterval(() => {
        if (Date.now() - last > 30000) {
          try { req.destroy(); } catch (e) { }
          finishOnce(reject, new Error('分片下载超时（30 秒无数据）'));
        }
      }, 5000);
      let settled = false;
      const finishOnce = (fn, v) => {
        if (settled) return;
        settled = true;
        clearInterval(guard);
        try { ws.destroy(); } catch (e) { }
        fn(v);
      };
      res.on('data', (chunk) => { last = Date.now(); try { if (onBytes) onBytes(chunk.length); } catch (e) { } });
      res.pipe(ws);
      ws.on('finish', () => finishOnce(resolve));
      ws.on('error', (err) => finishOnce(reject, err));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    req.end();
  });
}
// ── 模型库：读取 PyMSS 模型目录（人声提取/降噪/去回声等）──
ipcMain.handle('model-catalog', () => {
  try {
    const p = path.join(ROOT, 'Engine', 'tools', 'pymss', 'resources', 'model_catalog.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, models: j.models || [] };
  } catch (e) { return { ok: false, msg: String((e && e.message) || e) }; }
});

// 安装记录（编码文件 .rvcman + 配置 installed.json，类似 Steam appmanifest：
// 文件夹里放 10 位随机编码，装了才算；直接删文件夹/编码文件检测就失效）
const INSTALLED_FILE = path.join(APPDIR, 'installed.json');
const MANIFEST = '.rvcman';
function genCode() {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function readInstalled() {
  try {
    const j = JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { items: {} };
    j.items = j.items || {};
    return j;
  } catch (e) { return { items: {} }; }
}
function writeInstalled(obj) {
  try {
    const tmp = INSTALLED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, INSTALLED_FILE);
  } catch (e) { /* ignore */ }
}
function readManifest(dir) {
  try { return String(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).trim(); } catch (e) { return ''; }
}
// 记录安装：写编码文件到安装目录 + 写配置
ipcMain.handle('mark-installed', async (e, type, id, name, installPath, code) => {
  try {
    const t = ['voices', 'engines', 'models'].indexOf(String(type)) >= 0 ? String(type) : '';
    if (!t || !id || !installPath) return { ok: false, msg: '参数无效' };
    const c = String(code || '').trim() || genCode();
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, MANIFEST), c, 'utf8');
    const cfg = readInstalled();
    cfg.items[c] = { type: t, id: String(id), name: String(name || id), path: installPath, time: Date.now() };
    writeInstalled(cfg);
    return { ok: true, code: c };
  } catch (err) { return { ok: false, msg: String((err && err.message) || err) }; }
});
// 检测：校验配置里的编码（文件夹里编码文件不存在/不一致就删配置），并找出孤儿（有编码文件但配置没记录）
ipcMain.handle('assets-status', async (e, opts) => {
  const cfg = readInstalled();
  const valid = [];
  const orphans = [];
  const dead = [];
  for (const code of Object.keys(cfg.items)) {
    const it = cfg.items[code] || {};
    const mc = it.path ? readManifest(it.path) : '';
    if (!mc || mc !== code) { dead.push(code); continue; }
    valid.push({ code, type: it.type, id: it.id, name: it.name, path: it.path });
  }
  for (const d of dead) delete cfg.items[d];
  const known = (opts && opts.known) || {};
  const seen = {};
  const scanDir = (base, type) => {
    if (!base || !fs.existsSync(base)) return;
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
      for (const x of ents) {
        if (!x.isDirectory()) continue;
        const p = path.join(dir, x.name);
        const mc = readManifest(p);
        if (mc && !cfg.items[mc] && !seen[mc]) {
          seen[mc] = 1;
          let rel = x.name;
          try { if (p.toLowerCase().indexOf(String(base).toLowerCase()) === 0) rel = p.slice(String(base).length).replace(/^[\\/]+/, ''); } catch (e7) { }
          orphans.push({ path: p, code: mc, type, rel });
        } else if (!mc && depth > 0) {
          // 旧安装迁移：目录里有文件但没有编码文件 → 生成一次编码写进文件夹和配置
          let hasFile = false;
          try { hasFile = fs.readdirSync(p).some((fn) => { try { return fs.statSync(path.join(p, fn)).isFile(); } catch (err) { return false; } }); } catch (err) { }
          if (hasFile) {
            const nc = genCode();
            try {
              fs.writeFileSync(path.join(p, MANIFEST), nc, 'utf8');
              cfg.items[nc] = { type: type, id: x.name, name: x.name, path: p, time: Date.now() };
              valid.push({ code: nc, type: type, id: x.name, name: x.name, path: p });
            } catch (err) { }
          }
        }
        walk(p, depth + 1);
      }
    };
    walk(base, 0);
  };
  scanDir(known.voicesDir || VOICES_DIR, 'voices');
  scanDir(path.join(ROOT, 'Engine', 'runtimes'), 'engines');
  scanDir(path.join(ROOT, 'Engine', 'assets', 'pymss'), 'models');
  writeInstalled(cfg);
  return { ok: true, data: { valid, orphans } };
});
// 广场：删除已安装的运行时（下载其它引擎前清掉旧的）
ipcMain.handle('engine-remove', async (e, variant) => {
  try {
    const safe = String(variant || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!safe) return { ok: false, msg: '参数无效' };
    const d = path.join(ROOT, 'Engine', 'runtimes', safe);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    return { ok: true, removed: safe };
  } catch (err) { return { ok: false, msg: String((err && err.message) || err) }; }
});

// ─────────────────────── 自检修复（软件自身文件防误删） ───────────────────────
// 检测范围：CRVC VTFM（软件本体）+ Tools（软件脚本）。
// Engine/ 是可更换的引擎包，不检测。
// src = 内置修复包里的相对路径；critical = 缺失只能重装，无法自愈
const REPAIR_MANIFEST = [
  { key: 'exe', base: 'app', path: 'RVC VTFM.exe', kind: 'file', label: '主程序 RVC VTFM.exe', size: 60 * 1048576, critical: true },
  { key: 'asar', base: 'app', path: 'resources/app.asar', kind: 'file', label: '应用包 app.asar', size: 1048576, critical: true },
  { key: '7za', base: 'app', path: 'resources/7za.exe', kind: 'file', label: '解压工具 7za.exe', size: 256 * 1024, src: 'app/7za.exe' },
  { key: 'elevate', base: 'app', path: 'resources/elevate.exe', kind: 'file', label: '提权组件 elevate.exe', size: 16 * 1024, src: 'app/elevate.exe' },
  { key: 'workerenv', base: 'app', path: 'resources/worker_env.py', kind: 'file', label: '工作环境 worker_env.py', size: 1024, src: 'app/worker_env.py' },
  { key: 'rtworker', base: 'root', path: 'Tools/realtime_voice_worker.py', kind: 'file', label: '实时变音脚本', size: 4096, src: 'vbtools/realtime_voice_worker.py' },
  { key: 'rectest', base: 'root', path: 'Tools/record_test.py', kind: 'file', label: '录音脚本', size: 1024, src: 'vbtools/record_test.py' },
];

function repairAbs(item) {
  return path.join(item.base === 'app' ? APPDIR : ROOT, item.path);
}

function checkOne(item) {
  const abs = repairAbs(item);
  const res = { key: item.key, label: item.label, path: item.path, abs, ok: false, msg: '', critical: !!item.critical };
  if (!fs.existsSync(abs)) { res.msg = '文件不存在'; return res; }
  try {
    const st = fs.statSync(abs);
    if (item.size && st.size < item.size * 0.5) {
      res.msg = '文件偏小（可能损坏）：' + (st.size > 1048576 ? Math.round(st.size / 1048576) + 'MB' : Math.round(st.size / 1024) + 'KB');
      return res;
    }
  } catch (e) { res.msg = '无法读取'; return res; }
  res.ok = true;
  return res;
}

// 修复来源：软件内置 repair/vbtools（随 asar 打包）
function repairSources() {
  const srcs = [];
  for (const cand of [path.join(__dirname, 'repair'), path.join(process.resourcesPath || '', 'app.asar.unpacked', 'repair')]) {
    if (fs.existsSync(cand)) { srcs.push({ name: '内置修复包', base: cand }); break; }
  }
  return srcs;
}

async function repairOne(item, sources) {
  if (item.critical) {
    return { ok: false, msg: '无法自愈：这是软件本体文件，请重新安装 RVC VTFM' };
  }
  const dest = repairAbs(item);
  for (const src of sources) {
    const p = path.join(src.base, item.src);
    if (fs.existsSync(p)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fs.readFileSync(p));
        return { ok: true, by: src.name };
      } catch (e) { }
    }
  }
  return { ok: false, msg: '内置修复包中没有 ' + item.src };
}

ipcMain.handle('repair-check', () => {
  const items = REPAIR_MANIFEST.map(checkOne);
  const bad = items.filter((x) => !x.ok);
  return { ok: true, items, badCount: bad.length, sources: repairSources().map((s) => s.name) };
});

ipcMain.handle('repair-fix', async (e, keys) => {
  try {
    const sources = repairSources();
    if (!sources.length) return { ok: false, msg: '没有可用的修复来源（内置修复包缺失，请重装软件）' };
    const wanted = Array.isArray(keys) && keys.length ? keys : REPAIR_MANIFEST.map((x) => x.key);
    const results = [];
    for (const m of REPAIR_MANIFEST) {
      if (!wanted.includes(m.key)) continue;
      if (checkOne(m).ok) continue;
      if (m.critical) { results.push({ key: m.key, label: m.label, ok: false, by: '', msg: '软件本体文件，需重新安装' }); continue; }
      const r = await repairOne(m, sources);
      results.push({ key: m.key, label: m.label, ok: !!r.ok, by: r.by || '', msg: r.msg || '', restart: !!r.restart });
    }
    const items = REPAIR_MANIFEST.map(checkOne);
    const bad = items.filter((x) => !x.ok);
    return { ok: true, results, items, badCount: bad.length };
  } catch (err) { return { ok: false, msg: String((err && err.message) || err) }; }
});

// 目录合并：同名文件覆盖，其余保留（避免装 engine-core 时把用户的模型整个删掉）
function mergeDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { mergeDirSync(s, d); continue; }
    try { fs.copyFileSync(s, d); } catch (e) { }
  }
}

// 广场：安装运行时（解压 tar 到 Engine/runtimes/<variant>）
ipcMain.handle('engine-install', async (e, tarPath, variant) => {
  return new Promise((resolve) => {
    const safe = String(variant || '').replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!safe) { resolve({ ok: false, msg: '变体无效' }); return; }
    const src = String(tarPath || '');
    if (!src || !fs.existsSync(src)) { resolve({ ok: false, msg: '安装包不存在' }); return; }
    // engine-core（通用引擎核心）解压到 Engine/ 根；runtime-* 解压到 Engine/runtimes/<variant>；vbcable 解压到 Tools/vbcable
    const isCore = /core/i.test(safe);
    const isVb = /vbcable/i.test(safe);
    const base = path.join(ROOT, 'Engine');
    const dest = isVb ? path.join(ROOT, 'Tools', 'vbcable') : (isCore ? base : path.join(base, 'runtimes'));
    fs.mkdirSync(dest, { recursive: true });
    const tmp = path.join(dest, '_tmp_' + safe + '_' + Date.now());
    // zip 用 .NET 的 ZipFile 解压（比 tar 解 zip 快得多，避免几百 MB 卡十几分钟）
    let isZip = /\.zip$/i.test(src);
    if (!isZip) {
      try {
        const fd = fs.openSync(src, 'r');
        const b = Buffer.alloc(2);
        fs.readSync(fd, b, 0, 2, 0);
        fs.closeSync(fd);
        isZip = (b[0] === 0x50 && b[1] === 0x4B);
      } catch (e) { }
    }
    let ps;
    if (isZip) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const cmd = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(' + q(src) + ',' + q(tmp) + ')';
      ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    } else {
      fs.mkdirSync(tmp, { recursive: true });
      ps = spawn('tar', ['-xf', src, '-C', tmp], { windowsHide: true });
    }
    let errTxt = '';
    let settled = false;
    ps.stderr.on('data', (c) => { errTxt += c.toString('utf8'); });
    // 解压超时保护：超大文件 tar 卡住时不至于把界面永远挂在"排队中"
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ps.kill(); } catch (e2) { }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { }
      resolve({ ok: false, msg: '解压超时（600 秒），可能磁盘太慢或文件损坏' });
    }, 600000);
    ps.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: false, msg: '无法调用 tar：' + err.message }); });
    ps.on('exit', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { } resolve({ ok: false, msg: '解压失败：' + (errTxt || ('tar 退出码 ' + code)) }); return; }
      try {
        try { fs.unlinkSync(src); } catch (e9) { }  // 安装成功后删掉下载的压缩包
        const entries = fs.readdirSync(tmp, { withFileTypes: true });
        const dirs = entries.filter((d) => d.isDirectory());
        const files = entries.filter((d) => d.isFile());
        if (isVb) {
          // VB-Cable：解压到 Tools/vbcable，用户进去运行安装程序
          const srcDir = (dirs.length === 1 && files.length === 0) ? path.join(tmp, dirs[0].name) : tmp;
          mergeDirSync(srcDir, dest);
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { }
          resolve({ ok: true, path: dest, vbcable: true });
          return;
        }
        if (isCore) {
          // 通用引擎核心：合并到 Engine/ 根（同名文件覆盖，用户的模型/语音目录保留）
          const srcDir = (dirs.length === 1 && files.length === 0) ? path.join(tmp, dirs[0].name) : tmp;
          mergeDirSync(srcDir, base);
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { }
          try { ensureEngineLibs(); } catch (e5) { }
          resolve({ ok: true, path: base });
          return;
        }
        // 专用运行时：解压到 Engine/runtimes/<variant>
        const target = path.join(dest, safe);
        try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); } catch (e3) { }
        if (dirs.length === 1 && files.length === 0) {
          fs.renameSync(path.join(tmp, dirs[0].name), target);
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e4) { }
        } else {
          fs.renameSync(tmp, target);
        }
        // 装完运行时检查还缺不缺「引擎核心」（模型 + FFmpeg），缺就提示去广场补
        try { ensureEngineLibs(); } catch (e5) { }
        let needCore = false;
        try {
          needCore = !fs.existsSync(path.join(base, 'ffmpeg.exe'))
            || !fs.existsSync(path.join(base, 'assets', 'hubert'))
            || !fs.existsSync(path.join(base, 'assets', 'rmvpe'));
        } catch (e6) { }
        resolve({ ok: true, path: target, needCore });
      } catch (err) { resolve({ ok: false, msg: '安装失败：' + err.message }); }
    });
  });
});


// ── 下载队列（排队式：一次下载一个，先加入的先下载）──
let dlQueue = [];
let dlActive = null;
let dlSeq = 0;
let dlDoneCount = 0;
let dlDoneBytes = 0;
let _qT = 0, _qDone = 0;

function pushQueueStatus() {
  let active = null;
  if (dlActive) {
    const now = Date.now();
    if (!_qT) { _qT = now; _qDone = dlActive.done || 0; }
    else if (now - _qT >= 900) {
      dlActive.speed = Math.max(0, ((dlActive.done || 0) - _qDone) * 1000 / (now - _qT));
      _qT = now; _qDone = dlActive.done || 0;
    }
    active = { id: dlActive.id, name: dlActive.name, done: dlActive.done || 0, total: dlActive.size || 0, speed: dlActive.speed || 0 };
  } else { _qT = 0; }
  const st = {
    active: active,
    queue: dlQueue.map((t) => ({ id: t.id, name: t.name, size: t.size || 0 })),
    doneCount: dlDoneCount,
    doneBytes: dlDoneBytes,
    pendingCount: dlQueue.length + (dlActive ? 1 : 0),
  };
  const send = (w) => { try { if (w && !w.isDestroyed()) w.webContents.send('queue-status', st); } catch (e) { } };
  send(win);
  try { if (typeof plazaWin !== 'undefined' && plazaWin) send(plazaWin); } catch (e) { }
}

async function runQueue() {
  if (dlActive) return;
  const task = dlQueue.shift();
  if (!task) { pushQueueStatus(); return; }
  dlActive = task;
  pushQueueStatus();
  let result;
  try { result = await doDownload(task); } catch (err) { result = { ok: false, msg: String((err && err.message) || err) }; }
  dlActive = null;
  dlDoneCount++;
  dlDoneBytes += (task.size || 0);
  pushQueueStatus();
  // 关键：resolve 这个任务对应的 mt-download Promise，否则渲染进程的 await 永远挂起
  try { task.resolve(result); } catch (e) { }
  const done = { id: task.id, ok: !!(result && result.ok), result: result || {} };
  const send2 = (w) => { try { if (w && !w.isDestroyed()) w.webContents.send('dl-done', done); } catch (e) { } };
  send2(win);
  try { if (typeof plazaWin !== 'undefined' && plazaWin) send2(plazaWin); } catch (e) { }
  runQueue();
}

// 入队（返回 Promise，等这个任务真正下载完才 resolve；多个调用会排队串行下载）
// 入队前先 probe 拿文件大小，这样任务栏的总进度（按 MB）才算得准
ipcMain.handle('mt-download', async (e, opts) => {
  const url = String((opts && opts.url) || '').trim();
  const savePath = String((opts && opts.savePath) || '').trim();
  const threads = Math.max(1, Math.min(16, parseInt((opts && opts.threads) || 2, 10) || 2));
  if (!/^https?:\/\//i.test(url)) return { ok: false, msg: '地址需以 http:// 或 https:// 开头' };
  if (!savePath) return { ok: false, msg: '请填写保存位置' };
  let size = 0;
  try { const info = await probe(url); size = info.total || 0; } catch (err) { size = 0; }
  return new Promise((resolve) => {
    const task = {
      id: ++dlSeq,
      name: String((opts && opts.name) || ''),
      url: url, savePath: savePath, threads: threads,
      done: 0, size: size, sender: e.sender, resolve: resolve,
    };
    if (!task.name) { try { task.name = path.basename(savePath); } catch (err) { task.name = '下载'; } }
    dlQueue.push(task);
    pushQueueStatus();
    runQueue();
  });
});

async function doDownload(task) {
  const url = task.url;
  let savePath = task.savePath;
  const threads = task.threads;
  let info = await probe(url);
  const unknown = !info.total;
  if (unknown && info.code >= 400 && info.code !== 0) throw new Error('无法访问文件（HTTP ' + info.code + '）');
  const size = info.total;
  task.size = size;
  // cnb.cool 会 302 到带时效签名的临时地址，用原始 URL 让每个分片各自重新 302 拿到有效地址
  const dlUrl = url;
  if (/\.bin$/i.test(savePath) && info.filename && /\./.test(info.filename)) {
    try { savePath = savePath.replace(/\.bin$/i, info.filename.slice(info.filename.lastIndexOf('.'))); } catch (e) { }
  }
  task.savePath = savePath;
  const useRange = info.ranges;
  const n = (useRange && size) ? Math.min(threads, Math.max(1, Math.ceil(size / 262144))) : 1;
  const tmpDir = path.join(path.dirname(savePath), '.rvc-dl-' + Date.now());
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { }
  const progress = new Array(n).fill(0);
  const push = () => {
    task.done = progress.reduce((a, b) => a + b, 0);
    const payload = { done: task.done, total: size, parts: progress.slice(), ranges: useRange, unknown: unknown };
    const send = (w) => { try { if (w && !w.isDestroyed()) w.webContents.send('download-progress', payload); } catch (e2) { } };
    send(win);
    try { if (typeof plazaWin !== 'undefined' && plazaWin) send(plazaWin); } catch (e) { }
    pushQueueStatus();
  };
  const timer = setInterval(push, 250);
  dlState = { tmpDir: tmpDir, task: task };
  push();
  try {
    if (!useRange) {
      await fetchWhole(dlUrl, savePath, (len) => { progress[0] += len; });
      clearInterval(timer);
      push();
      dlState = null;
      return { ok: true, path: savePath, size: size, threads: 1, mode: '单线程（服务器不支持分段）' };
    }
    const partSize = Math.ceil(size / n);
    const parts = [];
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const s = i * partSize, en = Math.min(size - 1, s + partSize - 1);
      const f = path.join(tmpDir, 'part' + i);
      parts.push(f);
      const blockLen = en - s + 1;
      jobs.push((async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            progress[i] = 0;
            await fetchRange(dlUrl, s, en, f, (len) => { progress[i] += len; }, 0);
            progress[i] = blockLen;
            return;
          } catch (err) {
            if (attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      })());
    }
    await Promise.all(jobs);
    clearInterval(timer);
    push();
    const ws = fs.createWriteStream(savePath);
    for (const f of parts) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(f);
        rs.on('end', res); rs.on('error', rej);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise((res) => ws.end(res));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) { }
    dlState = null;
    return { ok: true, path: savePath, size: size, threads: n, mode: n + ' 线程分段' };
  } catch (err) {
    clearInterval(timer);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) { }
    dlState = null;
    throw err;
  }
}

ipcMain.handle('cancel-download', () => {
  dlQueue = [];
  if (dlState) { try { fs.rmSync(dlState.tmpDir, { recursive: true, force: true }); } catch (e) { } dlState = null; }
  return true;
});
// 删除单个文件（引擎 zip 安装完自动删）
ipcMain.handle('remove-file', (e, p) => {
  try { fs.unlinkSync(String(p)); return { ok: true }; } catch (err) { return { ok: false, msg: String((err && err.message) || err) }; }
});
ipcMain.handle('pick-save-path', async (e, def) => {
  const r = await dialog.showSaveDialog(win, { title: '选择保存位置', defaultPath: def || undefined });
  return r.canceled ? '' : r.filePath;
});

// ── 故障诊断用的通用文件查询 ──
// ── 保存诊断文本到「下载」目录 / 打开外部链接 ──
ipcMain.handle('save-text', (e, name, text) => {
  try {
    let dir = '';
    try { dir = app.getPath('downloads'); } catch (err) { dir = ''; }
    if (!dir) dir = path.join(process.env.USERPROFILE || '.', 'Downloads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'RVC-导出.txt').replace(/[\\/:*?"<>|]/g, '_');
    const out = path.join(dir, safe);
    fs.writeFileSync(out, String(text || ''), 'utf8');
    return { ok: true, path: out };
  } catch (err) { return { ok: false, msg: err.message }; }
});
// ── 打开小游戏独立窗口 ──
ipcMain.handle('get-downloads-dir', () => {
  try { return app.getPath('downloads'); } catch (err) { return path.join(process.env.USERPROFILE || '.', 'Downloads'); }
});
// ── 广场 ──
let plazaWin = null;
ipcMain.handle('open-plaza-window', () => {
  try {
    if (plazaWin && !plazaWin.isDestroyed()) { plazaWin.show(); plazaWin.focus(); return { ok: true }; }
    plazaWin = new BrowserWindow({
      width: 1020, height: 760, title: 'RVC 广场',
      autoHideMenuBar: true, backgroundColor: '#f6f2fb',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
    });
    plazaWin.show();
    plazaWin.focus();
    plazaWin.loadFile(path.join(__dirname, 'plaza.html'));
    plazaWin.on('closed', () => { plazaWin = null; });
    plazaWin.on('close', (e) => {
      if (dlState) {
        e.preventDefault();
        dialog.showMessageBox(plazaWin, {
          type: 'warning',
          buttons: ['继续下载', '强制退出'],
          defaultId: 0,
          cancelId: 0,
          message: '正在下载中',
          detail: '广场还有下载任务进行中，强制退出会中断并删除未完成的下载。',
        }).then((r) => {
          if (r.response === 1) {
            try { fs.rmSync(dlState.tmpDir, { recursive: true, force: true }); } catch (e2) { }
            dlState = null;
            try { plazaWin.destroy(); } catch (e2) { }
          }
        });
      }
    });
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('plaza-fetch', async (e, u) => {
  try {
    const url = String(u || '');
    if (!/^https:\/\/cnb\.cool\//i.test(url)) return { ok: false, msg: '仅允许访问 cnb.cool' };
    const res = await net.fetch(url);
    if (!res.ok) return { ok: false, msg: 'HTTP ' + res.status };
    return { ok: true, text: await res.text() };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('plaza-prepare', (e, base) => {
  try {
    const safe = String(base || 'item').replace(/[\\/:*?"<>|]/g, '_');
    const dir = path.join(os.tmpdir(), 'rvc-plaza-tmp', safe);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, dir };
  } catch (err) { return { ok: false, msg: err.message }; }
});
function findPthDeep(dir) {
  let out = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (st.isDirectory()) { const r = findPthDeep(fp); if (r) return r; }
      else if (f.toLowerCase().endsWith('.pth')) return fp;
    }
  } catch (e) { }
  return out;
}
ipcMain.handle('plaza-install', async (e, zipPath) => {
  try {
    if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, msg: '压缩包不存在' };
    const base = path.basename(zipPath, path.extname(zipPath));
    const dst = path.join(VOICES_DIR, base);
    if (fs.existsSync(dst)) return { ok: false, msg: 'Voice-LP 里已有同名文件夹「' + base + '」，请先移除旧的' };
    fs.mkdirSync(dst, { recursive: true });
    await new Promise((res, rej) => {
      const ps = spawn('tar', ['-xf', zipPath, '-C', dst], { windowsHide: true });
      ps.on('exit', (c) => (c === 0 ? res() : rej(new Error('解压失败（tar 退出码 ' + c + '）'))));
      ps.on('error', (err) => rej(new Error('系统 tar 不可用：' + err.message)));
    });
    if (!findPthDeep(dst)) {
      try { fs.rmSync(dst, { recursive: true }); } catch (e) { }
      return { ok: false, msg: '压缩包里没有找到 .pth 模型文件' };
    }
    try { fs.rmSync(zipPath, { force: true }); } catch (e) { }
    if (win && !win.isDestroyed()) win.webContents.send('voices-changed', { name: base });
    return { ok: true, name: base };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('rename-voice', (e, o) => {
  try {
    const old = String((o && o.old) || '').trim();
    const nn = String((o && o.name) || '').trim();
    if (!old || !nn) return { ok: false, msg: '名字不能为空' };
    if (/[\\/:*?"<>|]/.test(nn)) return { ok: false, msg: '名字不能包含 \\ / : * ? " < > | 字符' };
    const src = path.join(VOICES_DIR, old);
    const dst = path.join(VOICES_DIR, nn);
    if (!fs.existsSync(src)) return { ok: false, msg: '原文件夹不存在' };
    if (old !== nn && fs.existsSync(dst)) return { ok: false, msg: '已有同名声线「' + nn + '」' };
    fs.renameSync(src, dst);
    if (!findPthDeep(dst)) { try { fs.renameSync(dst, src); } catch (e2) { } return { ok: false, msg: '重命名后没有找到 .pth 模型，已还原' }; }
    // 同步重命名 Audio-RL 里对应的输出文件夹
    const rlOld = path.join(OUTPUT_DIR, old);
    const rlNew = path.join(OUTPUT_DIR, nn);
    if (fs.existsSync(rlOld)) {
      if (fs.existsSync(rlNew)) {
        try { fs.rmSync(rlOld, { recursive: true, force: true }); } catch (e3) { }
      } else {
        try { fs.renameSync(rlOld, rlNew); } catch (e3) { }
      }
    }
    const v = scanVoices().find((x) => x.name === nn);
    return { ok: true, name: nn, cover: v ? v.cover : null };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('delete-voice', (e, name) => {
  try {
    const n = String(name || '').trim();
    if (!n || n.includes('..') || /[\\/]/.test(n)) return { ok: false, msg: '无效的声线名字' };
    const dir = path.join(VOICES_DIR, n);
    if (!fs.existsSync(dir)) return { ok: false, msg: '文件夹不存在' };
    fs.rmSync(dir, { recursive: true, force: true });
    // 连带删除 Audio-RL 里对应的输出文件夹（同名声线的转换结果一起清）
    let rlRemoved = false;
    const rlDir = path.join(OUTPUT_DIR, n);
    if (fs.existsSync(rlDir)) {
      fs.rmSync(rlDir, { recursive: true, force: true });
      rlRemoved = true;
    }
    return { ok: true, rlRemoved };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('save-voice-cover', (e, o) => {
  try {
    const name = String((o && o.name) || '').trim();
    const dataUrl = String((o && o.dataUrl) || '');
    if (!name || !dataUrl.startsWith('data:image/')) return { ok: false, msg: '参数无效' };
    const dir = path.join(VOICES_DIR, name);
    if (!fs.existsSync(dir)) return { ok: false, msg: '声线文件夹不存在' };
    const stamp = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f)) {
        const p = path.join(dir, f);
        try { fs.renameSync(p, p + '.old' + stamp); } catch (e2) { }
      }
    }
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, 'cover.png'), buf);
    for (const f of fs.readdirSync(dir)) {
      if (f.includes('.old' + stamp)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch (e2) { } }
    }
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});

// ── 实时变声 ──
let rtProc = null;
let rtWin = null;
function rtWorkerPath() { return path.join(ROOT, 'Tools', 'realtime_voice_worker.py'); }
function rtSend(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('realtime-status', payload);
}
function rtRunOnce(args, timeoutMs) {
  return new Promise((resolve) => {
    const py = (findPython() || {}).python || '';
    if (!py) { resolve({ ok: false, msg: '找不到 Python 运行时（Engine/runtimes）' }); return; }
    const wp = rtWorkerPath();
    if (!fs.existsSync(wp)) { resolve({ ok: false, msg: '找不到实时模块（Tools/realtime_voice_worker.py）' }); return; }
    let out = '';
    let done = false;
    const ps = spawn(py, [wp, ...args], { cwd: path.join(ROOT, 'Engine'), windowsHide: true });
    const timer = setTimeout(() => { if (!done) { done = true; try { ps.kill(); } catch (e) { } resolve({ ok: false, msg: '查询超时' }); } }, timeoutMs || 25000);
    ps.stdout.on('data', (c) => { out += c.toString('utf8'); });
    ps.on('exit', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) { resolve({ ok: false, msg: '模块没有返回数据' }); return; }
      try { resolve({ ok: true, data: JSON.parse(line) }); }
      catch (e) { resolve({ ok: false, msg: '返回数据解析失败' }); }
    });
    ps.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, msg: e.message }); } });
  });
}
ipcMain.handle('realtime-devices', () => rtRunOnce(['--list-devices'], 30000));
ipcMain.handle('realtime-presets', () => rtRunOnce(['--list-presets'], 30000));
ipcMain.handle('realtime-start', async (e, cfg) => {
  try {
    if (rtProc) return { ok: false, msg: '实时变声已在运行' };
    const py = (findPython() || {}).python || '';
    if (!py) return { ok: false, msg: '找不到 Python 运行时（Engine/runtimes）' };
    const wp = rtWorkerPath();
    if (!fs.existsSync(wp)) return { ok: false, msg: '找不到实时模块' };
    const cfgPath = path.join(APPDIR, 'realtime_cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg || {}, null, 2), 'utf8');
    rtProc = spawn(py, [wp, '--config', cfgPath], { cwd: path.join(ROOT, 'Engine'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    rtWin = win;
    let buf = '';
    let rtStarted = false;
    // 启动超时兜底：PortAudio 初始化卡死（音频设备异常）时不再无限等待
    const startTimer = setTimeout(() => {
      if (rtProc && !rtStarted) {
        try { rtProc.kill(); } catch (e2) { }
        rtProc = null;
        rtSend({ type: 'error', msg: '实时变声启动超时：音频设备初始化卡死（通常是 VB-Audio Virtual Cable 驱动异常，请在设备管理器重装 VB-CABLE，或重启电脑后重试）' });
      }
    }, 15000);
    rtProc.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith('{')) continue;
        let o = null;
        try { o = JSON.parse(t); } catch (e2) { continue; }
        if (!rtStarted && (o.type === 'status' || o.type === 'ready')) { rtStarted = true; clearTimeout(startTimer); }
        rtSend(o);
      }
    });
    rtProc.stderr.on('data', (c) => rtSend({ type: 'stderr', msg: c.toString('utf8').slice(0, 300) }));
    rtProc.on('exit', (code) => {
      clearTimeout(startTimer);
      rtProc = null;
      rtSend({ type: 'status', state: 'exited', code: code });
    });
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('realtime-cmd', (e, payload) => {
  try {
    if (!rtProc || !rtProc.stdin.writable) return { ok: false, msg: '实时变声未运行' };
    rtProc.stdin.write(JSON.stringify(payload || {}) + '\n');
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('realtime-stop', () => {
  try {
    if (!rtProc) return { ok: true };
    try { rtProc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch (e) { }
    const proc = rtProc;
    setTimeout(() => { try { if (proc && !proc.killed) proc.kill(); } catch (e) { } }, 1200);
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});

const plazaImgCache = new Map();
ipcMain.handle('plaza-img', async (e, u) => {
  try {
    const url = String(u || '');
    if (!/^https:\/\/(cnb\.cool|huggingface\.co)\//i.test(url)) return { ok: false, msg: '域名不允许' };
    if (plazaImgCache.has(url)) return { ok: true, data: plazaImgCache.get(url) };
    const res = await net.fetch(url);
    if (!res.ok) return { ok: false, msg: 'HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8388608) return { ok: false, msg: '图片过大' };
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const data = 'data:' + ct + ';base64,' + buf.toString('base64');
    if (plazaImgCache.size > 400) { const first = plazaImgCache.keys().next().value; plazaImgCache.delete(first); }
    plazaImgCache.set(url, data);
    return { ok: true, data };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('open-game-window', (e, id) => {
  try {
    const wide = id === 'guess';
    const gw = new BrowserWindow({
      width: wide ? 540 : 1100,
      height: wide ? 440 : 840,
      title: 'RVC 小游戏',
      autoHideMenuBar: true,
      backgroundColor: '#0a0a1e',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    gw.show();
    gw.focus();
    gw.loadFile(path.join(__dirname, 'game.html'), { query: { g: id || 'snake360' } });
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('open-url', (e, u) => {
  try {
    const url = String(u || '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, msg: '仅支持 http(s) 链接' };
    shell.openExternal(url);
    return { ok: true };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('check-paths', (e, list) => (Array.isArray(list) ? list : []).map((p) => {
  let exists = false;
  try { exists = fs.existsSync(p); } catch (err) { }
  return { p, exists };
}));
ipcMain.handle('list-dir', (e, p) => {
  try { return fs.readdirSync(p).slice(0, 300); } catch (err) { return []; }
});
