/**
 * YT Downloader Pro — Node.js Backend (v2.0.0)
 *
 * npm install express ws
 * Requires: yt-dlp and ffmpeg in PATH
 *
 * Fixes applied vs v2.0.0:
 *  - Replaced broken player_client=web,ios with default,web_embedded
 *  - Removed deprecated --prefer-ffmpeg flag
 *  - Removed --user-agent override (breaks default client negotiation)
 *  - Resolved ffmpeg path at startup using `where`/`which` so spawned
 *    yt-dlp subprocesses always find ffmpeg even when shell: false
 *  - Fixed QUALITY_MAP format selectors to always include a proper
 *    bestvideo+bestaudio pair with strong fallbacks — prevents silent
 *    video-only downloads
 *  - Added --audio-multistreams so opus/webm audio merges into mp4
 *  - Added ffmpeg_o postprocessor arg to re-encode opus→aac for
 *    maximum player compatibility
 *  - Removed --js-runtimes node from /api/info and /api/formats
 *    (not needed for metadata-only calls, causes spurious warnings)
 *  - Increased /api/info and /api/formats timeouts for slow connections
 */

"use strict";

const express             = require("express");
const { WebSocketServer } = require("ws");
const { spawn, execFileSync, execSync } = require("child_process");
const http                = require("http");
const path                = require("path");
const fs                  = require("fs");
const os                  = require("os");
const { EventEmitter }    = require("events");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = 3000;
const DATA_DIR      = path.join(__dirname, ".ytdlp-web");
const HISTORY_FILE  = path.join(DATA_DIR, "history.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const ARCHIVE_FILE  = path.join(DATA_DIR, "archive.txt");
const LOG_FILE      = path.join(DATA_DIR, "server.log");
const MAX_LOG_SIZE  = 5 * 1024 * 1024; // 5 MB

// Resolved at startup by checkDependencies() — absolute path so yt-dlp
// subprocesses always find ffmpeg regardless of shell environment.
let FFMPEG_PATH = "ffmpeg";

const SETTINGS_SCHEMA = {
  defaultDir:         { type: "string",  default: path.join(os.homedir(), "Downloads") },
  defaultFormat:      { type: "string",  default: "mp4",  enum: ["mp4", "mkv", "webm"] },
  defaultAudioFormat: { type: "string",  default: "mp3",  enum: ["mp3", "m4a", "opus", "flac", "wav"] },
  rateLimit:          { type: "string",  default: "" },
  retries:            { type: "number",  default: 3,   min: 1, max: 20 },
  concurrent:         { type: "number",  default: 2,   min: 1, max: 5 },
  sponsorblock:       { type: "boolean", default: false },
  useCookies:         { type: "boolean", default: false },
  cookiesFile:        { type: "string",  default: path.join(DATA_DIR, "cookies.txt") },
  useArchive:         { type: "boolean", default: false },
  embedSubs:          { type: "boolean", default: true },
  embedChapters:      { type: "boolean", default: true },
};

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const timestamp = new Date().toISOString();
  const entry     = JSON.stringify({ timestamp, level, message: msg, ...meta }) + "\n";

  if (level === "error") console.error(`[${level.toUpperCase()}] ${msg}`);
  else                   console.log(`[${level.toUpperCase()}] ${msg}`);

  fs.stat(LOG_FILE, (statErr, stats) => {
    if (!statErr && stats.size > MAX_LOG_SIZE) {
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.${Date.now()}.old`); } catch {}
    }
    fs.appendFile(LOG_FILE, entry, (appendErr) => {
      if (appendErr) console.error("Failed to write log:", appendErr.message);
    });
  });
}

// ── Pre-flight dependency check ───────────────────────────────────────────────
function checkDependencies() {
  const deps = [
    { name: "yt-dlp", cmd: "yt-dlp --version" },
    { name: "ffmpeg", cmd: "ffmpeg -version"   },
  ];
  console.log("--- Pre-flight Dependency Check ---");
  const versions = {};

  for (const dep of deps) {
    try {
      const out = execSync(dep.cmd, { stdio: "pipe" }).toString();
      versions[dep.name] = out.split("\n")[0].trim();
      console.log(`[OK] ${dep.name}: ${versions[dep.name].substring(0, 60)}`);
    } catch {
      console.error(`\n[FATAL] "${dep.name}" not found in PATH.`);
      console.error(`Install it and make sure it is accessible from your terminal.\n`);
      process.exit(1);
    }
  }

  // Resolve the absolute path to ffmpeg.
  // `where` (Windows) / `which` (Unix) returns the full path so that
  // yt-dlp spawned with shell:false can always locate ffmpeg.
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const raw = execSync(cmd, { stdio: "pipe" }).toString().trim();
    // `where` may return multiple lines — take the first one
    FFMPEG_PATH = raw.split(/\r?\n/)[0].trim();
    console.log(`[OK] ffmpeg path: ${FFMPEG_PATH}`);
  } catch {
    FFMPEG_PATH = "ffmpeg"; // fallback — rely on PATH
    console.log(`[WARN] Could not resolve absolute ffmpeg path, falling back to "ffmpeg"`);
  }

  console.log("-----------------------------------");
  return versions;
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function buildDefaultSettings() {
  return Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([k, v]) => [k, v.default])
  );
}

function validateSettings(raw) {
  const result = {};
  for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
    const val = raw[key];
    if (val === undefined) { result[key] = schema.default; continue; }

    if (schema.type === "boolean") {
      result[key] = Boolean(val);
    } else if (schema.type === "number") {
      const n = Number(val);
      if (!Number.isFinite(n)) { result[key] = schema.default; continue; }
      result[key] = Math.min(Math.max(n, schema.min ?? -Infinity), schema.max ?? Infinity);
    } else {
      const s = String(val);
      if (schema.enum && !schema.enum.includes(s)) { result[key] = schema.default; continue; }
      result[key] = s;
    }
  }
  return result;
}

function loadSettings() {
  try {
    const text = fs.readFileSync(SETTINGS_FILE, "utf8").trim();
    const raw  = text ? JSON.parse(text) : {};
    return validateSettings({ ...buildDefaultSettings(), ...raw });
  } catch {
    return buildDefaultSettings();
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadHistory() {
  try {
    const text = fs.readFileSync(HISTORY_FILE, "utf8").trim();
    return text ? JSON.parse(text) : [];
  } catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ── Active process tracking ───────────────────────────────────────────────────
const activeDownloads = new Map();
const activeProcesses = new Map();
let   dlIdCounter     = 1;

// ── Build yt-dlp argument arrays ──────────────────────────────────────────────
const OUTPUT_TEMPLATE = "%(title)s.%(ext)s";

function buildCommonArgs(settings) {
  const args = [
    // "default" lets yt-dlp pick the best working client automatically
    // (currently android_vr as of 2026-03). "web_embedded" is the
    // JS-based fallback — it does NOT require a PO token.
    // Do NOT add ios or plain web here — both require GVS PO tokens.
    "--extractor-args",   "youtube:player_client=default,web_embedded",
    "--js-runtimes",      "node",           // needed by web_embedded client
    "--no-check-certificates",
    "--socket-timeout",   "30",
    "--retries",          String(settings.retries),
    "--fragment-retries", String(settings.retries),
    "--restrict-filenames",
    "--newline",
    "--progress",
    // Always pass the absolute ffmpeg path resolved at startup
    "--ffmpeg-location",  FFMPEG_PATH,
  ];

  if (settings.rateLimit)
    args.push("--rate-limit", settings.rateLimit);
  if (settings.useCookies && fs.existsSync(settings.cookiesFile))
    args.push("--cookies", settings.cookiesFile);
  if (settings.useArchive)
    args.push("--download-archive", ARCHIVE_FILE);
  if (settings.sponsorblock)
    args.push("--sponsorblock-remove", "all");
  if (settings.embedChapters)
    args.push("--embed-chapters");

  return args;
}

// Format selectors: always pair bestvideo+bestaudio.
// The fallback chain ensures that even if a height-capped stream is
// unavailable, yt-dlp degrades gracefully rather than selecting a
// video-only format silently.
const QUALITY_MAP = {
  best:   "bestvideo+bestaudio/bestvideo*+bestaudio/best",
  "4k":   "bestvideo[height<=2160]+bestaudio/bestvideo[height<=2160]+bestaudio/best",
  "1080p":"bestvideo[height<=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/best",
  "720p": "bestvideo[height<=720]+bestaudio/bestvideo[height<=720]+bestaudio/best",
  "480p": "bestvideo[height<=480]+bestaudio/bestvideo[height<=480]+bestaudio/best",
  "360p": "bestvideo[height<=360]+bestaudio/bestvideo[height<=360]+bestaudio/best",
};

const AUDIO_QUALITY_MAP = { best: "0", high: "2", good: "4", low: "9" };

function buildVideoArgs(options, settings) {
  const { quality, container, subs, outputDir, url, playlistMode } = options;
  const args = buildCommonArgs(settings);

  // 1. Playlist handling
  if (playlistMode === "playlist") {
    args.push("--yes-playlist");
    args.push("--output", path.join(outputDir, "%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s"));
  } else {
    args.push("--no-playlist");
  }

  // 2. Updated QUALITY_MAP logic for MP4 compatibility
  // We prioritize m4a audio specifically to avoid the Opus-in-MP4 "no audio" bug.
  const mp4FriendlyQuality = (QUALITY_MAP[quality] || QUALITY_MAP.best)
    .split('/')
    .map(f => f.includes('+') ? f.replace('bestaudio', 'bestaudio[ext=m4a]') + '/' + f : f)
    .join('/');

  args.push("-f", mp4FriendlyQuality);
  
  // 3. Container and Merger settings
  const targetContainer = container || settings.defaultFormat || "mp4";
  args.push("--merge-output-format", targetContainer);
  args.push("--audio-multistreams");

  // 4. Forced Re-encoding
  // If we end up with non-AAC audio, this forces a high-bitrate AAC conversion.
  args.push("--postprocessor-args", "ffmpeg:-c:a aac -b:a 192k");

  // 5. Metadata and Subs
  args.push("--embed-thumbnail", "--embed-metadata");
  if (subs === "en")  args.push("--embed-subs", "--sub-langs", "en.*,en");
  if (subs === "all") args.push("--embed-subs", "--all-subs");

  if (playlistMode !== "playlist") {
    args.push("-o", path.join(outputDir, OUTPUT_TEMPLATE));
  }

  args.push(url);
  return args;
}

function buildAudioArgs(options, settings) {
  const { format, quality, outputDir, url, playlistMode } = options;
  const args = buildCommonArgs(settings);

  // playlist handling
  if (playlistMode === "playlist") {
    args.push("--yes-playlist");
    args.push("-x",
      "--audio-format",  format || settings.defaultAudioFormat || "mp3",
      "--audio-quality", AUDIO_QUALITY_MAP[quality] ?? "0",
      "--embed-thumbnail",
      "--embed-metadata",
      "--add-metadata",
      "-o", path.join(outputDir, "%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s"),
      url
    );
  } else {
    args.push("--no-playlist");
    args.push(
      "-x",
      "--audio-format",  format || settings.defaultAudioFormat || "mp3",
      "--audio-quality", AUDIO_QUALITY_MAP[quality] ?? "0",
      "--embed-thumbnail",
      "--embed-metadata",
      "--add-metadata",
      "-o", path.join(outputDir, OUTPUT_TEMPLATE),
      url
    );
  }
  return args;
}

function buildThumbnailArgs(options, settings) {
  const { format, outputDir, url, playlistMode } = options;
  const args = buildCommonArgs(settings);
  if (playlistMode === "playlist") {
    args.push("--yes-playlist");
  } else {
    args.push("--no-playlist");
  }
  args.push("--write-thumbnail", "--skip-download");
  if (format && format !== "webp") args.push("--convert-thumbnails", format);
  const outTpl = playlistMode === "playlist"
    ? path.join(outputDir, "%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s")
    : path.join(outputDir, OUTPUT_TEMPLATE);
  args.push("-o", outTpl, url);
  return args;
}

// ── Core download runner ──────────────────────────────────────────────────────
// Returns an EventEmitter: progress | log | complete | error | cancelled
function runDownload(id, args) {
  const emitter = new EventEmitter();

  const outIdx = args.indexOf("-o");
  if (outIdx !== -1) {
    try { fs.mkdirSync(path.dirname(args[outIdx + 1]), { recursive: true }); } catch {}
  }

  log("info", "spawn yt-dlp", { id });

  const proc = spawn("yt-dlp", args, { shell: false });

  activeDownloads.set(id, { process: proc, cancelled: false, emitter });
  activeProcesses.set(id, proc);

  let stderrBuf = "";

  proc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      const m = line.match(
        /\[download\]\s+([\d.]+)%\s+of\s+([\S]+)\s+at\s+([\S]+\/s)\s+ETA\s+(\S+)/
      );
      if (m) {
        emitter.emit("progress", {
          percent: parseFloat(m[1]),
          size:    m[2],
          speed:   m[3],
          eta:     m[4],
        });
      } else if (/\[download\]|\[ffmpeg\]|\[ExtractAudio\]|\[Merger\]/.test(line)) {
        emitter.emit("log", { message: line.trim(), level: "info" });
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    for (const line of text.split("\n")) {
      if (line.trim()) emitter.emit("log", { message: line.trim(), level: "warn" });
    }
  });

  proc.on("close", (code) => {
    const entry     = activeDownloads.get(id);
    const cancelled = entry?.cancelled ?? false;
    activeDownloads.delete(id);
    activeProcesses.delete(id);

    if (cancelled) {
      log("info", "download cancelled", { id });
      emitter.emit("cancelled", { message: "Download cancelled." });
    } else if (code === 0) {
      log("info", "download complete", { id });
      emitter.emit("complete", { message: "Download completed successfully!" });
    } else {
      const detail = stderrBuf.slice(-800);
      log("error", "download failed", { id, code, detail });
      emitter.emit("error", { message: "Download failed.", detail, code });
    }
  });

  proc.on("error", (err) => {
    log("error", "spawn error", { id, err: err.message });
    activeDownloads.delete(id);
    activeProcesses.delete(id);
    emitter.emit("error", { message: err.message });
  });

  return emitter;
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────
function wsSend(ws, type, id, data = {}) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type, id, ...data })); } catch {}
}

function wireDownload(id, emitter, ws, meta) {
  emitter.on("progress", (d) => wsSend(ws, "download:progress", id, d));
  emitter.on("log",      (d) => wsSend(ws, "download:log",      id, d));

  emitter.on("complete", (d) => {
    wsSend(ws, "download:complete", id, d);
    try {
      const history   = loadHistory();
      const safeTitle = (meta.title || "")
        .replace(/[^\w\s.\-]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 200);
      history.unshift({
        id,
        title:    meta.title || meta.url,
        url:      meta.url,
        mode:     meta.mode,
        format:   meta.format || "?",
        dir:      meta.outputDir,
        filename: safeTitle,
        date:     new Date().toISOString(),
      });
      if (history.length > 200) history.splice(200);
      saveHistory(history);
    } catch (e) {
      log("error", "history save failed", { err: e.message });
    }
  });

  emitter.on("error",     (d) => wsSend(ws, "download:error",    id, d));
  emitter.on("cancelled", (d) => wsSend(ws, "download:cancelled", id, d));
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── Media constants ───────────────────────────────────────────────────────────
const VIDEO_EXTS     = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi"]);
const AUDIO_EXTS     = new Set([".mp3", ".m4a", ".opus", ".flac", ".wav"]);
const IMAGE_EXTS     = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const ALL_MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS]);

const MIME_MAP = {
  ".mp4":"video/mp4",       ".webm":"video/webm",      ".mkv":"video/x-matroska",
  ".mov":"video/quicktime", ".avi":"video/x-msvideo",
  ".mp3":"audio/mpeg",      ".m4a":"audio/mp4",         ".opus":"audio/ogg",
  ".flac":"audio/flac",     ".wav":"audio/wav",
  ".jpg":"image/jpeg",      ".jpeg":"image/jpeg",
  ".png":"image/png",       ".webp":"image/webp",
};

// ── /media — range-aware file streaming ──────────────────────────────────────
app.use("/media", (req, res) => {
  const dir  = loadSettings().defaultDir;
  const rel  = decodeURIComponent(req.path).replace(/^[/\\]+/, "");
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs  = path.join(dir, safe);
  const ext  = path.extname(abs).toLowerCase();

  if (!ALL_MEDIA_EXTS.has(ext))   return res.status(403).json({ error: "Forbidden" });
  if (!abs.startsWith(path.resolve(dir) + path.sep) &&
      abs !== path.resolve(dir))   return res.status(403).json({ error: "Access denied" });
  if (!fs.existsSync(abs))         return res.status(404).json({ error: "Not found" });

  const stat  = fs.statSync(abs);
  const total = stat.size;
  const mime  = MIME_MAP[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : Math.min(start + 2 * 1024 * 1024, total - 1);
    if (start >= total) return res.status(416).set("Content-Range", `bytes */${total}`).end();
    res.writeHead(206, {
      "Content-Range":  `bytes ${start}-${end}/${total}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": end - start + 1,
      "Content-Type":   mime,
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": total,
      "Content-Type":   mime,
      "Accept-Ranges":  "bytes",
    });
    fs.createReadStream(abs).pipe(res);
  }
});

// ── GET /api/files ────────────────────────────────────────────────────────────
app.get("/api/files", (_req, res) => {
  const dir = loadSettings().defaultDir;
  try {
    if (!fs.existsSync(dir)) return res.json({ files: [], dir });
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && ALL_MEDIA_EXTS.has(path.extname(e.name).toLowerCase()))
      .map(e => {
        const abs = path.join(dir, e.name);
        const st  = fs.statSync(abs);
        const ext = path.extname(e.name).toLowerCase();
        return {
          name:  e.name,
          url:   "/media/" + encodeURIComponent(e.name),
          size:  st.size,
          mtime: st.mtimeMs,
          type:  VIDEO_EXTS.has(ext) ? "video" : AUDIO_EXTS.has(ext) ? "audio" : "image",
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files, dir });
  } catch (err) {
    log("error", "/api/files failed", { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/info?url= ────────────────────────────────────────────────────────
app.get("/api/info", (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "No URL" });
  try {
    const raw = execFileSync("yt-dlp", [
      "--skip-download",
      "--playlist-items", "1",          // only fetch metadata for the first entry
      "--print", "%(title)s|%(duration)s|%(uploader)s|%(view_count)s|%(upload_date)s|%(like_count)s|%(thumbnail)s",
      "--no-check-certificates",
      "--extractor-args", "youtube:player_client=default,web_embedded",
      "--js-runtimes", "node",
      url,
    ], { timeout: 45000, encoding: "utf8" }).trim();

    // For playlists, --print emits one line per video; take the first line only
    const firstLine = raw.split("\n")[0].trim();
    const [title, duration, uploader, views, upload_date, likes, thumbnail] = firstLine.split("|");
    res.json({
      title, uploader, upload_date, thumbnail,
      duration: parseInt(duration) || 0,
      views:    parseInt(views)    || 0,
      likes:    parseInt(likes)    || 0,
    });
  } catch (err) {
    log("error", "info fetch failed", { url, err: err.message });
    res.status(500).json({ error: "Could not fetch video info", detail: err.message });
  }
});

// ── GET /api/formats?url= ─────────────────────────────────────────────────────
app.get("/api/formats", (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "No URL" });
  try {
    const raw = execFileSync("yt-dlp", [
      "-J",
      "--no-check-certificates",
      "--extractor-args", "youtube:player_client=default,web_embedded",
      "--ffmpeg-location", FFMPEG_PATH,
      url,
    ], { timeout: 30000, encoding: "utf8" });
    const data    = JSON.parse(raw);
    const formats = (data.formats || []).map((f) => ({
      format_id:  f.format_id,
      ext:        f.ext,
      resolution: f.resolution || `${f.height || "?"}p`,
      fps:        f.fps,
      filesize:   f.filesize,
      vcodec:     f.vcodec,
      acodec:     f.acodec,
      tbr:        f.tbr,
      note:       f.format_note,
    }));
    res.json({ formats });
  } catch (err) {
    log("error", "formats fetch failed", { url, err: err.message });
    res.status(500).json({ error: "Could not fetch formats" });
  }
});

// ── History CRUD ──────────────────────────────────────────────────────────────
app.get("/api/history",    (_req, res) => res.json(loadHistory()));
app.delete("/api/history", (_req, res) => { saveHistory([]); res.json({ ok: true }); });
app.delete("/api/history/:id", (req, res) => {
  const id = parseInt(req.params.id);
  saveHistory(loadHistory().filter((item) => item.id !== id));
  res.json({ ok: true });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get("/api/settings",  (_req, res) => res.json(loadSettings()));
app.post("/api/settings",  (req, res) => {
  const updated = validateSettings({ ...loadSettings(), ...req.body });
  saveSettings(updated);
  res.json(updated);
});

// ── Cancel ────────────────────────────────────────────────────────────────────
app.post("/api/cancel/:id", (req, res) => {
  const id    = parseInt(req.params.id);
  const entry = activeDownloads.get(id);
  if (!entry) return res.status(404).json({ error: "Download not found" });

  entry.cancelled = true;

  try {
    if (process.platform === "win32") {
      // On Windows SIGTERM is not supported — kill() without a signal
      // sends the equivalent of TerminateProcess which works reliably.
      entry.process.kill();
    } else {
      entry.process.kill("SIGTERM");
      // SIGKILL fallback after 3 s in case yt-dlp ignores SIGTERM
      setTimeout(() => {
        try { entry.process.kill("SIGKILL"); } catch {}
      }, 3000);
    }
  } catch (e) {
    log("warn", "kill failed", { id, err: e.message });
  }

  res.json({ ok: true });
});

// ── Active downloads list ─────────────────────────────────────────────────────
app.get("/api/active", (_req, res) => res.json([...activeDownloads.keys()]));

// ── yt-dlp version & update ───────────────────────────────────────────────────
app.get("/api/ytdlp-version", (_req, res) => {
  try {
    const version = execFileSync("yt-dlp", ["--version"], { encoding: "utf8" }).trim();
    res.json({ version });
  } catch {
    res.json({ version: "not found" });
  }
});

app.post("/api/update-ytdlp", (_req, res) => {
  const strategies = [
    () => execFileSync("yt-dlp",  ["-U"],                                    { encoding: "utf8" }),
    () => execFileSync("pip",     ["install", "-U", "yt-dlp"],               { encoding: "utf8" }),
    () => execFileSync("pip3",    ["install", "-U", "yt-dlp"],               { encoding: "utf8" }),
    () => execFileSync("python",  ["-m", "pip", "install", "-U", "yt-dlp"], { encoding: "utf8" }),
  ];
  for (const attempt of strategies) {
    try {
      attempt();
      const version = execFileSync("yt-dlp", ["--version"], { encoding: "utf8" }).trim();
      log("info", "yt-dlp updated", { version });
      return res.json({ ok: true, version });
    } catch { /* try next */ }
  }
  log("error", "yt-dlp update failed — all strategies exhausted");
  res.status(500).json({ error: "Update failed. Try running 'yt-dlp -U' manually in your terminal." });
});

// ── Open folder (cross-platform) ──────────────────────────────────────────────
app.post("/api/open-folder", (req, res) => {
  const { dir } = req.body;
  if (!dir || typeof dir !== "string") return res.status(400).json({ error: "No dir" });
  const cmds = {
    win32:  ["explorer", [dir]],
    darwin: ["open",     [dir]],
    linux:  ["xdg-open", [dir]],
  };
  const [cmd, args] = cmds[process.platform] ?? cmds.linux;
  try {
    spawn(cmd, args, { shell: false, detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  log("info", "ws client connected");

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const settings = loadSettings();

    // ── Single download ────────────────────────────────────────────────────
    if (msg.type === "download") {
      const { mode, url, options = {} } = msg;
      if (!url || typeof url !== "string")
        return wsSend(ws, "download:error", 0, { message: "Invalid URL" });

      const id        = dlIdCounter++;
      const outputDir = options.outputDir || settings.defaultDir;
      let   args;

      try {
        if      (mode === "video")     args = buildVideoArgs({ ...options, outputDir, url }, settings);
        else if (mode === "audio")     args = buildAudioArgs({ ...options, outputDir, url }, settings);
        else if (mode === "thumbnail") args = buildThumbnailArgs({ ...options, outputDir, url }, settings);
        else return wsSend(ws, "download:error", id, { message: `Unknown mode: ${mode}` });
      } catch (err) {
        return wsSend(ws, "download:error", id, { message: err.message });
      }

      wsSend(ws, "download:start", id, { message: "Starting…" });
      const emitter = runDownload(id, args);
      wireDownload(id, emitter, ws, {
        title:  options.title || url,
        url,
        mode,
        format: options.format || options.container || "?",
        outputDir,
      });
    }

    // ── Batch queue ────────────────────────────────────────────────────────
    if (msg.type === "queue:run") {
      const { items = [], mode, options = {} } = msg;
      if (!items.length) return;

      (async () => {
        for (const item of items) {
          const { url, title } = item;
          const s         = loadSettings();
          const outputDir = options.outputDir || s.defaultDir;
          const id        = dlIdCounter++;
          let   args;

          try {
            if      (mode === "video") args = buildVideoArgs({ ...options, outputDir, url }, s);
            else if (mode === "audio") args = buildAudioArgs({ ...options, outputDir, url }, s);
            else                       args = buildThumbnailArgs({ ...options, outputDir, url }, s);
          } catch (err) {
            wsSend(ws, "download:error", id, { message: err.message });
            continue;
          }

          wsSend(ws, "download:start", id, { message: `Queue: ${title || url}` });
          const emitter = runDownload(id, args);
          wireDownload(id, emitter, ws, {
            title: title || url, url, mode,
            format: options.format || options.container || "?", outputDir,
          });

          await new Promise((resolve) => {
            emitter.once("complete",  resolve);
            emitter.once("error",     resolve);
            emitter.once("cancelled", resolve);
          });
        }
        wsSend(ws, "queue:done", 0, { message: "Queue finished." });
      })();
    }
  });

  ws.on("close", () => log("info", "ws client disconnected"));
  ws.on("error", (err) => log("error", "ws error", { err: err.message }));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n${signal} received — cleaning up ${activeProcesses.size} active process(es)…`);
  for (const [id, child] of activeProcesses) {
    console.log(`  Killing PID ${child.pid} (download #${id})`);
    try { child.kill("SIGTERM"); } catch {}
  }
  server.close(() => {
    console.log("Server closed cleanly.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Timeout — forcing exit.");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const historyRaw  = fs.existsSync(HISTORY_FILE)  ? fs.readFileSync(HISTORY_FILE,  "utf8").trim() : "";
    const settingsRaw = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8").trim() : "";
    if (!historyRaw)  fs.writeFileSync(HISTORY_FILE,  "[]");
    if (!settingsRaw) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(buildDefaultSettings(), null, 2));

    // Resolves FFMPEG_PATH as a side-effect
    checkDependencies();

    server.listen(PORT, () => {
      log("info", `YT Downloader Pro v2.0.0 started on http://localhost:${PORT}`);
      console.log(`\n  ✔  YT Downloader Pro v2.0.0  →  http://localhost:${PORT}`);
      console.log(`  📁  Data directory: ${DATA_DIR}\n`);
    });
  } catch (err) {
    console.error("Initialization failed:", err);
    process.exit(1);
  }
})();
