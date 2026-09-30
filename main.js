const {
  Plugin, PluginSettingTab, Setting, Notice,
  TFile, TFolder, normalizePath,
} = require("obsidian");
const http = require("http");
const url = require("url");
const crypto = require("crypto");
const os = require("os");

// ---------- Константы ----------
const DEFAULT_PORT = 27125;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_BODY = 32 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60000;

const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  token: "",
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  bindHost: "127.0.0.1",
  allowNetwork: false,
  readOnly: false,
  rateLimitPerMin: DEFAULT_RATE_LIMIT,
  excludedInterfaces: [],
};

// ---------- MIME / text-vs-binary ----------
const TEXT_EXT = new Set([
  "md","markdown","txt","json","csv","tsv","yaml","yml","xml","html","htm",
  "css","js","mjs","cjs","ts","tsx","jsx","sh","bash","zsh","py","rb","go",
  "rs","java","c","h","cpp","hpp","log","ini","conf","toml","env","tex",
  "svg",
]);

const MIME_BY_EXT = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

function extOf(p) {
  const i = String(p).lastIndexOf(".");
  if (i < 0) return "";
  return String(p).slice(i + 1).toLowerCase();
}
function isTextPath(p) {
  const e = extOf(p);
  if (!e) return true;
  return TEXT_EXT.has(e);
}
function mimeOf(p) {
  const e = extOf(p);
  return MIME_BY_EXT[e] || "application/octet-stream";
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// =========================================================
// PLUGIN
// =========================================================
class RestApiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    if (!this.settings.token) {
      this.settings.token = crypto.randomBytes(32).toString("hex");
      await this.saveSettings();
    }
    this._authFails = new Map();
    this._cleanupTimer = window.setInterval(() => this._rateLimitCleanup(), RATE_WINDOW_MS);
    this.addSettingTab(new RestApiSettingTab(this.app, this));
    this.restartServer();
    console.log(
      "[REST API] loaded on http://" + this.settings.bindHost + ":" + this.settings.port +
      (this.settings.readOnly ? " [read-only]" : "")
    );
  }

  async onunload() {
    this.stopServer();
    if (this._cleanupTimer) { window.clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
    console.log("[REST API] unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
    if (!this.settings.bindHost) this.settings.bindHost = "127.0.0.1";
    if (!this.settings.allowNetwork) this.settings.bindHost = "127.0.0.1";
    if (!this.settings.token) this.settings.token = crypto.randomBytes(32).toString("hex");
    if (!Array.isArray(this.settings.excludedInterfaces)) this.settings.excludedInterfaces = [];
  }

  async saveSettings() { await this.saveData(this.settings); }

  stopServer() {
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
  }

  restartServer() {
    this.stopServer();
    const s = this.settings;
    const host = s.allowNetwork ? "0.0.0.0" : "127.0.0.1";

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("[REST API] unhandled:", err);
        this.sendError(res, new ApiError(500, "internal_error", "Internal server error"));
      });
    });

    this.server.on("error", (err) => {
      if (err.code === "EADDRINUSE") new Notice("[REST API] Порт " + s.port + " уже занят");
      else new Notice("[REST API] Ошибка сервера: " + err.message);
      console.error("[REST API] server error:", err);
    });

    this.server.listen(s.port, host, () => {
      console.log("[REST API] listening on http://" + host + ":" + s.port);
      if (host === "0.0.0.0") {
        for (const ip of this.getLanAddresses()) {
          console.log("[REST API]   → http://" + ip + ":" + s.port);
        }
      }
    });
  }

  // ---------- Node http client (без CORS, в обход Obsidian renderer) ----------
  httpGetJson(urlStr, headers, timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    return new Promise((resolve, reject) => {
      let u;
      try { u = url.parse(urlStr); }
      catch (e) { return reject(e); }
      const req = http.request({
        host: u.hostname,
        port: u.port || 80,
        path: (u.path || "/") + (u.search || ""),
        method: "GET",
        headers: headers || {},
        timeout: timeoutMs,
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: data, json });
        });
      });
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.on("error", reject);
      req.end();
    });
  }

  // ---------- Network interfaces ----------
  listInterfaces() {
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === "IPv4") {
          out.push({ name, address: info.address, netmask: info.netmask, internal: !!info.internal });
        }
      }
    }
    return out;
  }

  getLanAddresses() {
    const excluded = new Set(this.settings.excludedInterfaces || []);
    const out = [];
    for (const iface of this.listInterfaces()) {
      if (iface.internal) continue;
      if (excluded.has(iface.name)) continue;
      out.push(iface.address);
    }
    return out;
  }

  getExcludedRanges() {
    const excluded = new Set(this.settings.excludedInterfaces || []);
    if (!excluded.size) return [];
    const out = [];
    for (const iface of this.listInterfaces()) {
      if (iface.internal) continue;
      if (!excluded.has(iface.name)) continue;
      out.push({ address: iface.address, netmask: iface.netmask });
    }
    return out;
  }

  _ipToInt(s) {
    const parts = String(s).split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const v = parseInt(p, 10);
      if (isNaN(v) || v < 0 || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  }

  _isIpInRange(ip, net, mask) {
    const a = this._ipToInt(ip), n = this._ipToInt(net), m = this._ipToInt(mask);
    if (a === null || n === null || m === null) return false;
    return (a & m) === (n & m);
  }

  isExcludedRemote(rawIp) {
    if (!rawIp) return false;
    const ip = String(rawIp).replace(/^::ffff:/, "");
    if (ip === "127.0.0.1" || ip === "::1") return false;
    for (const r of this.getExcludedRanges()) {
      if (this._isIpInRange(ip, r.address, r.netmask)) return true;
    }
    return false;
  }

  // ---------- Security utils ----------
  safeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ab = Buffer.from(a), bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  rateLimitOk(ip) {
    const now = Date.now();
    const e = this._authFails.get(ip);
    if (!e || now > e.resetAt) return true;
    return e.count < this.settings.rateLimitPerMin;
  }
  rateLimitHit(ip) {
    const now = Date.now();
    const e = this._authFails.get(ip);
    if (!e || now > e.resetAt) this._authFails.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    else e.count++;
  }
  _rateLimitCleanup() {
    const now = Date.now();
    for (const [ip, e] of this._authFails) {
      if (now > e.resetAt) this._authFails.delete(ip);
    }
  }

  sanitizePath(path) {
    if (path === null || path === undefined) return "";
    let clean = String(path);
    if (clean.indexOf("\u0000") !== -1) return null;
    clean = clean.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean === "") return "";
    if (/^[A-Za-z]:/.test(clean)) return null;
    if (clean.startsWith("//")) return null;
    for (const p of clean.split("/")) {
      if (p === ".." || p === ".") return null;
      const lp = p.toLowerCase();
      if (lp.startsWith(".obsidian")) return null;
      if (lp === ".trash" || lp === ".git" || lp === ".smart-env") return null;
    }
    return normalizePath(clean);
  }

  // ---------- HTTP pipeline ----------
  async handleRequest(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const origin = req.headers["origin"];
    if (typeof origin === "string" && /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|app:\/\/obsidian\.md)$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const parsedUrl = url.parse(req.url || "", true);
    let pathname;
    try { pathname = decodeURIComponent(parsedUrl.pathname || ""); }
    catch (_) { return this.sendError(res, new ApiError(400, "invalid_request", "Invalid URL encoding")); }
    const query = parsedUrl.query || {};

    const authHeader = req.headers["authorization"];
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const ip = (req.socket && req.socket.remoteAddress) || "unknown";

    if (this.isExcludedRemote(ip)) {
      return this.sendError(res, new ApiError(403, "forbidden", "Requests from this network interface are disabled"));
    }
    if (!this.rateLimitOk(ip)) {
      return this.sendError(res, new ApiError(429, "too_many_requests", "Too many requests"));
    }
    this.rateLimitHit(ip);

    // /health — публичный liveness-эндпоинт, без токена
    if (pathname === "/health" && req.method === "GET") {
      return this.sendJson(res, 200, { status: "ok" });
    }

    if (!this.safeEqual(token, this.settings.token)) {
      return this.sendError(res, new ApiError(401, "unauthorized", "Invalid or missing token"));
    }
    if (this.settings.readOnly && ["PUT", "POST", "DELETE", "PATCH"].includes(req.method)) {
      return this.sendError(res, new ApiError(403, "forbidden", "Server is in read-only mode"));
    }

    let rawBody = null;
    let body = "";
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      try { rawBody = await this.readBody(req); }
      catch (e) { return this.sendError(res, new ApiError(413, "payload_too_large", "Body exceeds " + MAX_BODY + " bytes")); }
      body = rawBody.toString("utf8");
    }

    try { await this.route(req, res, pathname, query, body, rawBody); }
    catch (err) {
      if (err instanceof ApiError) return this.sendError(res, err);
      console.error("[REST API] route error:", err);
      this.sendError(res, new ApiError(500, "internal_error", "Internal server error"));
    }
  }

  async route(req, res, pathname, query, body, rawBody) {
    const m = req.method;

    if (pathname === "/capabilities" && m === "GET") {
      return this.sendJson(res, 200, {
        batch_read: true, batch_write: true, batch_delete: true, move: true,
        rmdir: true, tree: true, meta: true, backlinks: true, outlinks: true,
        search: { mode: ["lexical", "regex", "exact", "fuzzy"], snippet: true },
        atomic_batch: true, events: false, read_only_mode: this.settings.readOnly,
        binary: true,
        upload: { json_base64: "/upload", raw_put: "/vault/{path}" },
      });
    }
    if (pathname === "/upload" && m === "POST") return this.handleUpload(res, body);
    if (pathname === "/vault" || pathname === "/vault/" || pathname.startsWith("/vault/")) {
      return this.handleVault(req, res, pathname, body, rawBody);
    }
    if (pathname === "/batch/read"   && m === "POST") return this.handleBatchRead(res, body);
    if (pathname === "/batch/write"  && m === "POST") return this.handleBatchWrite(res, body);
    if (pathname === "/batch/delete" && m === "POST") return this.handleBatchDelete(res, body);
    if (pathname === "/batch/move"   && m === "POST") return this.handleBatchMove(res, body);
    if (pathname === "/tree"  && m === "GET")  return this.handleTree(res, query);
    if (pathname === "/mkdir" && m === "POST") return this.handleMkdir(res, body);
    if (pathname.startsWith("/folder/") && m === "DELETE") return this.handleDeleteFolder(res, pathname.slice("/folder/".length), query);
    if (pathname === "/rmdir" && m === "POST") return this.handleRmdir(res, body);
    if (pathname === "/search" && m === "GET") return this.handleSearch(res, query);
    if (pathname === "/search_by_tags" && m === "POST") return this.handleSearchByTags(res, body);
    if (pathname.startsWith("/backlinks/") && m === "GET") return this.handleBacklinks(res, pathname.slice("/backlinks/".length));
    if (pathname.startsWith("/outlinks/")  && m === "GET") return this.handleOutlinks(res, pathname.slice("/outlinks/".length));
    if (pathname.startsWith("/meta/")      && m === "GET") return this.handleMeta(res, pathname.slice("/meta/".length));

    throw new ApiError(404, "not_found", "Endpoint not found: " + pathname);
  }

  async handleVault(req, res, pathname, body, rawBody) {
    const raw = pathname === "/vault" || pathname === "/vault/" ? "" : pathname.slice("/vault/".length);
    const isListing = raw === "" || raw.endsWith("/");
    const p = this.sanitizePath(raw);
    if (p === null) throw new ApiError(400, "invalid_request", "Invalid path", { path: raw });

    if (req.method === "GET") {
      if (isListing) return this.handleList(res, p);

      if (!isTextPath(p)) {
        const buf = await this.readBinary(p);
        if (buf === null) throw new ApiError(404, "not_found", "File not found: " + p, { path: p });
        res.writeHead(200, {
          "Content-Type": mimeOf(p),
          "Content-Length": buf.length,
        });
        res.end(buf);
        return;
      }
      const c = await this.readFile(p);
      if (c === null) throw new ApiError(404, "not_found", "File not found: " + p, { path: p });
      res.writeHead(200, { "Content-Type": mimeOf(p) });
      res.end(c);
      return;
    }
    if (req.method === "PUT") {
      if (isListing) throw new ApiError(400, "invalid_request", "Cannot write to a directory");

      if (!isTextPath(p)) {
        if (!rawBody || rawBody.length === 0) throw new ApiError(400, "invalid_request", "Empty body");
        if (rawBody.length > this.settings.maxFileSize) {
          throw new ApiError(413, "payload_too_large",
            "File exceeds max size (" + this.settings.maxFileSize + " bytes)");
        }
        await this.writeBinary(p, rawBody);
        return this.sendJson(res, 200, { ok: true, size: rawBody.length, mime: mimeOf(p) });
      }
      if (Buffer.byteLength(body, "utf8") > this.settings.maxFileSize) {
        throw new ApiError(413, "payload_too_large",
          "File exceeds max size (" + this.settings.maxFileSize + " bytes)");
      }
      await this.writeFile(p, body, "overwrite");
      return this.sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST") {
      if (isListing) throw new ApiError(400, "invalid_request", "Cannot append to a directory");
      if (!isTextPath(p)) throw new ApiError(400, "invalid_request", "Append not supported for binary files");
      if (Buffer.byteLength(body, "utf8") > this.settings.maxFileSize) {
        throw new ApiError(413, "payload_too_large",
          "Append exceeds max size (" + this.settings.maxFileSize + " bytes)");
      }
      await this.writeFile(p, body, "append");
      return this.sendJson(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      if (isListing || p === "") throw new ApiError(400, "invalid_request", "Use DELETE /folder/{path} for directories");
      const ok = await this.deleteFile(p);
      if (!ok) throw new ApiError(404, "not_found", "File not found: " + p, { path: p });
      res.writeHead(204); res.end();
      return;
    }
    throw new ApiError(405, "method_not_allowed", "Method not allowed");
  }

  async handleList(res, p) {
    const folder = this.app.vault.getAbstractFileByPath(p || "/");
    if (!folder || !(folder instanceof TFolder)) throw new ApiError(404, "not_found", "Folder not found: " + (p || "/"));
    const files = [];
    for (const child of folder.children) {
      if (child instanceof TFile) files.push(child.name);
      else if (child instanceof TFolder) files.push(child.name + "/");
    }
    this.sendJson(res, 200, { files });
  }

  async handleBatchRead(res, body) {
    const d = this.parseJson(body);
    const paths = Array.isArray(d.paths) ? d.paths : [];
    const files = {};
    for (const pp of paths) {
      const key = String(pp);
      const p = this.sanitizePath(pp);
      files[key] = p === null ? null : await this.readFile(p);
    }
    this.sendJson(res, 200, { files });
  }

  async handleBatchWrite(res, body) {
    const d = this.parseJson(body);
    const files = Array.isArray(d.files) ? d.files : [];
    const atomic = !!d.atomic;

    if (atomic) {
      const backups = [];
      for (const f of files) {
        const p = this.sanitizePath(f && f.path);
        if (p === null) continue;
        if (!isTextPath(p)) {
          throw new ApiError(400, "invalid_request", "Binary files are not supported by batch/write");
        }
        const exists = await this.app.vault.adapter.exists(p);
        const content = exists ? await this.readFile(p) : null;
        if (exists && content === null) {
          throw new ApiError(413, "payload_too_large", "Cannot back up existing file (too large): " + p);
        }
        backups.push({ path: p, existed: exists, content });
      }
      const results = [];
      try {
        for (const f of files) {
          const p = this.sanitizePath(f && f.path);
          if (p === null) throw new Error("invalid path");
          await this.writeFile(p, String((f && f.content) || ""), f && f.mode === "append" ? "append" : "overwrite");
          results.push({ path: String(f.path), ok: true });
        }
        return this.sendJson(res, 200, { results, atomic: true });
      } catch (e) {
        for (const b of backups) {
          try {
            if (!b.existed) await this.deleteFile(b.path);
            else if (b.content !== null) await this.writeFile(b.path, b.content, "overwrite");
          } catch (_) {}
        }
        throw new ApiError(409, "conflict", "Atomic batch failed; rolled back", { rolled_back: backups.length });
      }
    }

    const results = [];
    for (const f of files) {
      const p = this.sanitizePath(f && f.path);
      if (p === null) { results.push({ path: String(f && f.path), ok: false, error: "invalid_path" }); continue; }
      if (!isTextPath(p)) { results.push({ path: String(f && f.path), ok: false, error: "binary_not_supported" }); continue; }
      try {
        await this.writeFile(p, String((f && f.content) || ""), f && f.mode === "append" ? "append" : "overwrite");
        results.push({ path: String(f.path), ok: true });
      } catch (_) { results.push({ path: String(f.path), ok: false, error: "internal" }); }
    }
    this.sendJson(res, 200, { results });
  }

  async handleBatchDelete(res, body) {
    const d = this.parseJson(body);
    const paths = Array.isArray(d.paths) ? d.paths : [];
    const deleted = [], not_found = [];
    for (const pp of paths) {
      const p = this.sanitizePath(pp);
      if (p === null || p === "") { not_found.push(String(pp)); continue; }
      (await this.deleteFile(p)) ? deleted.push(String(pp)) : not_found.push(String(pp));
    }
    this.sendJson(res, 200, { deleted, not_found });
  }

  async handleBatchMove(res, body) {
    const d = this.parseJson(body);
    const moves = Array.isArray(d.moves) ? d.moves : [];
    const results = [];
    for (const mv of moves) {
      const from = this.sanitizePath(mv && mv.from);
      const to = this.sanitizePath(mv && mv.to);
      if (from === null || to === null || from === "" || to === "") {
        results.push({ from: String(mv && mv.from), to: String(mv && mv.to), ok: false, error: "invalid_path" });
        continue;
      }
      try {
        if (!isTextPath(from) || !isTextPath(to)) {
          results.push({ from: String(mv.from), to: String(mv.to), ok: false, error: "binary_not_supported" });
          continue;
        }
        const c = await this.readFile(from);
        if (c === null) { results.push({ from: String(mv.from), to: String(mv.to), ok: false, error: "not_found" }); continue; }
        if (await this.app.vault.adapter.exists(to)) {
          results.push({ from: String(mv.from), to: String(mv.to), ok: false, error: "conflict" });
          continue;
        }
        await this.writeFile(to, c, "overwrite");
        await this.deleteFile(from);
        results.push({ from: String(mv.from), to: String(mv.to), ok: true });
      } catch (_) {
        results.push({ from: String(mv && mv.from), to: String(mv && mv.to), ok: false, error: "internal" });
      }
    }
    this.sendJson(res, 200, { results });
  }

  async handleTree(res, query) {
    const withHash = query.with_hash === "1";
    const withMtime = query.with_mtime === "1";
    const withSize = query.with_size === "1";
    const dirsOnly = query.dirs_only === "1";
    const filesOnly = query.files_only === "1";

    const files = [], dirs = [], meta = {};
    if (!dirsOnly) {
      for (const f of this.app.vault.getFiles()) {
        files.push(f.path);
        if (withHash || withMtime || withSize) {
          meta[f.path] = {};
          if (withSize)  meta[f.path].size = f.stat.size;
          if (withMtime) meta[f.path].mtime = new Date(f.stat.mtime).toISOString();
          if (withHash) {
            if (isTextPath(f.path)) {
              const c = await this.app.vault.adapter.read(f.path);
              meta[f.path].hash = "sha256:" + crypto.createHash("sha256").update(c).digest("hex");
            } else {
              const buf = await this.readBinary(f.path);
              meta[f.path].hash = buf
                ? "sha256:" + crypto.createHash("sha256").update(buf).digest("hex")
                : null;
            }
          }
        }
      }
    }
    if (!filesOnly) {
      for (const f of this.app.vault.getAllLoadedFiles()) {
        if (f instanceof TFolder && f.path !== "/") dirs.push(f.path);
      }
    }
    this.sendJson(res, 200, { files, dirs, meta });
  }

  async handleMkdir(res, body) {
    const d = this.parseJson(body);
    const p = this.sanitizePath(d.path);
    if (p === null || p === "") throw new ApiError(400, "invalid_request", "Invalid path");
    await this.ensureFolder(p);
    this.sendJson(res, 200, { ok: true });
  }

  async handleDeleteFolder(res, rawPath, query) {
    const p = this.sanitizePath(rawPath);
    if (p === null) throw new ApiError(400, "invalid_request", "Invalid path");
    if (p === "") throw new ApiError(400, "invalid_request", "Cannot delete vault root");

    const folder = this.app.vault.getAbstractFileByPath(p);
    if (!folder || !(folder instanceof TFolder)) {
      throw new ApiError(404, "not_found", "Folder not found: " + p, { path: p });
    }

    const emptyOnly = query.empty_only === "1";
    const recursive = query.recursive === "1";
    const hasChildren = folder.children.length > 0;

    if (hasChildren && emptyOnly) {
      return this.sendJson(res, 200, { deleted: [], skipped: [p] });
    }
    if (hasChildren && !recursive) {
      throw new ApiError(409, "conflict", "Folder is not empty; use ?recursive=1 or ?empty_only=1", { path: p });
    }

    const childrenSnapshot = [...folder.children];

    try {
      await this.app.vault.delete(folder);
      const deleted = childrenSnapshot.map((c) => c.path);
      deleted.push(p);
      return this.sendJson(res, 200, { deleted, skipped: [] });
    } catch (e1) {
      console.warn("[REST API] vault.delete(folder) failed, falling back to adapter.rmdir:",
        (e1 && e1.message) || String(e1));
    }

    try {
      await this.app.vault.adapter.rmdir(p, recursive);
      const deleted = childrenSnapshot.map((c) => c.path);
      deleted.push(p);
      return this.sendJson(res, 200, { deleted, skipped: [] });
    } catch (e2) {
      console.error("[REST API] adapter.rmdir failed:", e2);
      throw new ApiError(
        500,
        "internal_error",
        "Folder delete failed: " + ((e2 && e2.message) || String(e2)),
        { path: p }
      );
    }
  }

  async handleRmdir(res, body) {
    const d = this.parseJson(body);
    const paths = Array.isArray(d.paths) ? d.paths : [];
    const deleted = [], not_empty = [];

    for (const pp of paths) {
      const key = String(pp);
      const p = this.sanitizePath(pp);
      if (p === null || p === "") { not_empty.push(key); continue; }

      const folder = this.app.vault.getAbstractFileByPath(p);
      if (!(folder instanceof TFolder) || folder.children.length !== 0) {
        not_empty.push(key);
        continue;
      }

      let removed = false;

      try {
        await this.app.vault.delete(folder);
        removed = true;
      } catch (e1) {
        console.warn("[REST API] rmdir: vault.delete failed for", p, (e1 && e1.message) || String(e1));
      }

      if (!removed) {
        try {
          await this.app.vault.adapter.rmdir(p, false);
          removed = true;
        } catch (e2) {
          console.error("[REST API] rmdir: adapter.rmdir failed for", p, e2);
        }
      }

      if (removed) deleted.push(key);
      else not_empty.push(key);
    }

    this.sendJson(res, 200, { deleted, not_empty });
  }

  async handleSearch(res, query) {
    const q = query.q || "";
    if (!q) throw new ApiError(400, "invalid_request", "Missing 'q' parameter");
    const limit = Math.max(1, Math.min(1000, parseInt(query.limit || "50", 10) || 50));
    const mode = query.mode || "lexical";
    const inPath = query.in_path === "1";
    const inContent = query.in_content === "1" || !inPath;
    const exact = query.exact === "1";

    let fmKey = "", fmVal = "";
    if (query.frontmatter && query.frontmatter.includes(":")) {
      const idx = query.frontmatter.indexOf(":");
      fmKey = query.frontmatter.slice(0, idx).trim();
      fmVal = query.frontmatter.slice(idx + 1).trim();
    }

    const matcher = this.buildMatcher(q, mode, exact);
    const hits = [];
    for (const f of this.app.vault.getFiles()) {
      if (hits.length >= limit) break;
      if (fmKey) {
        const cache = this.app.metadataCache.getFileCache(f);
        const fm = (cache && cache.frontmatter) || {};
        const v = fm[fmKey];
        const ok = Array.isArray(v) ? v.map(String).includes(fmVal) : String(v == null ? "" : v).includes(fmVal);
        if (!ok) continue;
      }
      let score = 0, snippet = "";
      if (inPath && matcher(f.path)) score += 1;
      if (inContent && isTextPath(f.path)) {
        const c = await this.app.vault.cachedRead(f);
        const m = matcher(c);
        if (m) {
          score += 0.5;
          const i = (m && m.index != null) ? m.index : c.toLowerCase().indexOf(q.toLowerCase());
          if (i >= 0) snippet = c.slice(Math.max(0, i - 60), Math.min(c.length, i + q.length + 60));
        }
      }
      if (score > 0) hits.push({ path: f.path, score, snippet });
    }
    hits.sort((a, b) => b.score - a.score);
    this.sendJson(res, 200, { hits: hits.slice(0, limit) });
  }

  buildMatcher(q, mode, exact) {
    if (mode === "regex") {
      let re;
      try { re = new RegExp(q, "i"); }
      catch (_) { throw new ApiError(400, "invalid_request", "Invalid regex"); }
      return (s) => re.exec(s);
    }
    if (mode === "exact" || exact) return (s) => { const i = s.indexOf(q); return i === -1 ? null : { index: i }; };
    if (mode === "fuzzy") {
      const lq = q.toLowerCase();
      return (s) => {
        const ls = s.toLowerCase();
        let i = 0;
        for (let j = 0; j < ls.length && i < lq.length; j++) if (ls[j] === lq[i]) i++;
        return i === lq.length ? { index: 0 } : null;
      };
    }
    const lq = q.toLowerCase();
    return (s) => { const i = s.toLowerCase().indexOf(lq); return i === -1 ? null : { index: i }; };
  }

  async handleSearchByTags(res, body) {
    const d = this.parseJson(body);
    const tags = (Array.isArray(d.tags) ? d.tags : []).map((t) => String(t).replace(/^#/, ""));
    const op = d.op === "or" ? "or" : "and";
    const limit = Math.max(1, Math.min(1000, d.limit || 50));
    const paths = [];
    for (const f of this.app.vault.getFiles()) {
      if (paths.length >= limit) break;
      const cache = this.app.metadataCache.getFileCache(f);
      const inline = (cache && cache.tags ? cache.tags.map((t) => t.tag.replace(/^#/, "")) : []);
      const fmRaw = cache && cache.frontmatter && cache.frontmatter.tags;
      const fm = fmRaw ? (Array.isArray(fmRaw) ? fmRaw : [fmRaw]).map((t) => String(t).replace(/^#/, "")) : [];
      const ft = Array.from(new Set(inline.concat(fm)));
      const match = op === "and" ? tags.every((t) => ft.includes(t)) : tags.some((t) => ft.includes(t));
      if (match) paths.push(f.path);
    }
    this.sendJson(res, 200, { paths });
  }

  async handleBacklinks(res, target) {
    const p = this.sanitizePath(target);
    if (p === null) throw new ApiError(400, "invalid_request", "Invalid path");
    const rl = this.app.metadataCache.resolvedLinks;
    const backlinks = [];
    for (const src of Object.keys(rl)) if (rl[src] && rl[src][p]) backlinks.push(src);
    this.sendJson(res, 200, { backlinks, count: backlinks.length });
  }

  async handleOutlinks(res, source) {
    const p = this.sanitizePath(source);
    if (p === null) throw new ApiError(400, "invalid_request", "Invalid path");
    const rl = this.app.metadataCache.resolvedLinks[p] || {};
    const ul = this.app.metadataCache.unresolvedLinks[p] || {};
    const outlinks = [];
    for (const t of Object.keys(rl)) outlinks.push({ target: t, resolved: true });
    for (const t of Object.keys(ul)) outlinks.push({ target: t, resolved: false });
    this.sendJson(res, 200, { outlinks });
  }

  async handleMeta(res, rawPath) {
    const p = this.sanitizePath(rawPath);
    if (p === null) throw new ApiError(400, "invalid_request", "Invalid path");
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !(file instanceof TFile)) throw new ApiError(404, "not_found", "File not found: " + p);

    const binary = !isTextPath(p);
    let hash;
    if (binary) {
      const buf = await this.readBinary(p);
      if (buf === null) throw new ApiError(500, "internal_error", "Failed to read file");
      hash = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
    } else {
      const c = await this.app.vault.cachedRead(file);
      hash = "sha256:" + crypto.createHash("sha256").update(c).digest("hex");
    }

    const cache = this.app.metadataCache.getFileCache(file);
    this.sendJson(res, 200, {
      path: p,
      size: file.stat.size,
      mtime: new Date(file.stat.mtime).toISOString(),
      ctime: new Date(file.stat.ctime).toISOString(),
      hash,
      mime: mimeOf(p),
      binary,
      frontmatter: (cache && cache.frontmatter) || {},
      wikilinks: (cache && cache.links) ? cache.links.map((l) => l.link) : [],
      tags: (cache && cache.tags) ? cache.tags.map((t) => t.tag.replace(/^#/, "")) : [],
    });
  }

  async handleUpload(res, body) {
    const d = this.parseJson(body);
    const p = this.sanitizePath(d.path);
    if (p === null || p === "") throw new ApiError(400, "invalid_request", "Invalid path");

    const raw = String(d.content_base64 || d.base64 || "");
    if (!raw) throw new ApiError(400, "invalid_request", "Missing 'content_base64'");
    const b64 = raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");

    let buf;
    try { buf = Buffer.from(b64, "base64"); }
    catch (_) { throw new ApiError(400, "invalid_request", "Invalid base64"); }
    if (!buf || buf.length === 0) throw new ApiError(400, "invalid_request", "Empty content");
    if (buf.length > this.settings.maxFileSize) {
      throw new ApiError(413, "payload_too_large",
        "File exceeds max size (" + this.settings.maxFileSize + " bytes)");
    }

    await this.writeBinary(p, buf);
    this.sendJson(res, 200, { ok: true, path: p, size: buf.length, mime: mimeOf(p) });
  }

  async ensureFolder(path) {
    if (!path) return;
    const parts = path.split("/");
    let cur = "";
    for (const part of parts) {
      if (!part) continue;
      cur = cur ? cur + "/" + part : part;
      if (!(await this.app.vault.adapter.exists(cur))) {
        try { await this.app.vault.createFolder(cur); } catch (_) {}
      }
    }
  }

  async readFile(path) {
    try {
      if (!path) return null;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const st = await adapter.stat(path);
      if (st && st.size > this.settings.maxFileSize) return null;
      return await adapter.read(path);
    } catch (_) { return null; }
  }

  async readBinary(path) {
    try {
      if (!path) return null;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      const st = await adapter.stat(path);
      if (st && st.size > this.settings.maxFileSize) return null;
      const ab = await adapter.readBinary(path);
      return Buffer.from(ab);
    } catch (_) { return null; }
  }

  async writeFile(path, content, mode) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await this.ensureFolder(dir);
    if (mode === "append") {
      const ex = await this.readFile(path);
      if (ex !== null) content = ex + "\n\n" + content;
    }
    await this.app.vault.adapter.write(path, content);
  }

  async writeBinary(path, buffer) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await this.ensureFolder(dir);
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await this.app.vault.adapter.writeBinary(path, ab);
  }

  async deleteFile(path) {
    try {
      if (!path) return false;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) return false;
      await adapter.remove(path);
      return true;
    } catch (_) { return false; }
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { req.destroy(); reject(new Error("payload_too_large")); return; }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  parseJson(body) {
    try { return JSON.parse(body); }
    catch (_) { throw new ApiError(400, "invalid_request", "Invalid JSON body"); }
  }

  sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  sendError(res, err) {
    if (!(err instanceof ApiError)) err = new ApiError(500, "internal_error", "Internal server error");
    const out = { error: err.code, message: err.message, status: err.status };
    if (err.details) out.details = err.details;
    this.sendJson(res, err.status, out);
  }
}

// =========================================================
// SETTINGS UI
// =========================================================
class RestApiSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.showToken = false;
    this.showEndpoints = true;
    this.statusOk = null;
    this._autoChecked = false;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    try {
      const scroller = containerEl.closest(".vertical-tab-content") || containerEl.parentElement;
      if (scroller && scroller.style) scroller.style.scrollbarGutter = "stable";
    } catch (_) {}

    const S = {
      card: "padding:14px 16px;border-radius:8px;background:var(--background-secondary);margin-bottom:12px;",
      row: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
      label: "font-weight:600;color:var(--text-normal);font-size:14px;",
      hint: "color:var(--text-muted);font-size:12px;margin-top:2px;",
      badgeOk: "display:inline-block;padding:2px 10px;border-radius:12px;background:var(--text-success);color:#fff;font-size:12px;font-weight:600;",
      badgeErr: "display:inline-block;padding:2px 10px;border-radius:12px;background:var(--text-error);color:#fff;font-size:12px;font-weight:600;",
      badgeWait: "display:inline-block;padding:2px 10px;border-radius:12px;background:var(--text-muted);color:#fff;font-size:12px;font-weight:600;",
      mono: "font-family:var(--font-monospace);font-size:12px;",
      code: "display:block;padding:10px 12px;border-radius:6px;background:var(--background-primary);border:1px solid var(--background-modifier-border);font-family:var(--font-monospace);font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--text-normal);margin-top:6px;",
    };

    const btnStyle = "padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px;border:none;";
    const btnPrimary = btnStyle + "background:var(--interactive-accent);color:var(--text-on-accent);";
    const btnNormal = btnStyle + "background:var(--interactive-normal);color:var(--text-normal);";
    const btnWarn = btnStyle + "background:var(--text-error);color:#fff;";

    const lan = this.plugin.getLanAddresses();
    const host = s.allowNetwork ? "0.0.0.0" : "127.0.0.1";
    const baseUrl = "http://" + (host === "0.0.0.0" ? (lan[0] || "127.0.0.1") : host) + ":" + s.port;
    const loopbackUrl = "http://127.0.0.1:" + s.port;

    // ---------- HEADER ----------
    const header = containerEl.createDiv({ attr: { style: S.card } });
    const headerRow = header.createDiv({ attr: { style: S.row } });
    headerRow.createEl("div", { text: "REST API", attr: { style: "font-size:18px;font-weight:700;color:var(--text-normal);" } });
    const badgeEl = headerRow.createEl("span", {
      text: this.statusOk === null ? "Проверка..." : (this.statusOk ? "Работает" : "Не отвечает"),
      cls: "rest-api-status-badge",
      attr: { style: this.statusOk === null ? S.badgeWait : (this.statusOk ? S.badgeOk : S.badgeErr) },
    });
    badgeEl.dataset.badgeOk = S.badgeOk;
    badgeEl.dataset.badgeErr = S.badgeErr;

    const info = header.createDiv({ attr: { style: "margin-top:8px;" } });
    info.createEl("div", { text: "Локальный HTTP-сервер для агентов и автоматизации. Работает, пока Obsidian открыт.", attr: { style: S.hint } });
    const urlLine = info.createDiv({ attr: { style: "margin-top:6px;" } });
    urlLine.createEl("a", { text: baseUrl, attr: { href: baseUrl + "/health", target: "_blank", style: S.mono + "color:var(--text-accent);" } });

    // ---------- TOKEN ----------
    const tokenCard = containerEl.createDiv({ attr: { style: S.card } });
    tokenCard.createEl("div", { text: "Токен доступа", attr: { style: S.label } });
    tokenCard.createEl("div", { text: "Все запросы, кроме /health, должны содержать заголовок Authorization: Bearer <токен>. Храните его в секрете.", attr: { style: S.hint } });

    const tokenRow = tokenCard.createDiv({ attr: { style: S.row + "margin-top:10px;" } });
    tokenRow.createEl("code", {
      text: this.showToken ? s.token : (s.token.slice(0, 8) + "\u2026" + s.token.slice(-8)),
      attr: { style: S.mono + "padding:6px 10px;border-radius:6px;background:var(--background-primary);flex:1;min-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--text-normal);" },
    });

    tokenRow.createEl("button", { text: this.showToken ? "Скрыть" : "Показать", attr: { style: btnNormal } })
      .onclick = () => { this.showToken = !this.showToken; this.display(); };

    tokenRow.createEl("button", { text: "Скопировать", attr: { style: btnPrimary } })
      .onclick = async (ev) => {
        try {
          await navigator.clipboard.writeText(s.token);
          new Notice("Токен скопирован в буфер обмена");
          const b = ev.currentTarget; const t = b.textContent;
          b.textContent = "Скопировано";
          setTimeout(() => { b.textContent = t; }, 1500);
        } catch (e) { new Notice("Не удалось скопировать: " + e.message); }
      };

    tokenRow.createEl("button", { text: "Сгенерировать новый", attr: { style: btnWarn } })
      .onclick = async () => {
        if (!confirm("Сгенерировать новый токен? Все интеграции придётся обновить — старый сразу перестанет работать.")) return;
        s.token = crypto.randomBytes(32).toString("hex");
        await this.plugin.saveSettings();
        new Notice("Новый токен сгенерирован");
        this.display();
      };

    // ---------- NETWORK ----------
    const netCard = containerEl.createDiv({ attr: { style: S.card } });
    netCard.createEl("div", { text: "Сеть", attr: { style: S.label } });

    const netRow = netCard.createDiv({ attr: { style: S.row + "margin-top:10px;" } });
    netRow.createEl("div", {
      text: "Разрешить доступ из локальной сети",
      attr: { style: "flex:1;color:var(--text-normal);font-size:13px;" },
    });
    const netToggle = netRow.createEl("input", { attr: { type: "checkbox" } });
    netToggle.checked = !!s.allowNetwork;
    netToggle.onchange = async () => {
      s.allowNetwork = netToggle.checked;
      s.bindHost = s.allowNetwork ? "0.0.0.0" : "127.0.0.1";
      await this.plugin.saveSettings();
      this.plugin.restartServer();
      this.statusOk = null;
      this._autoChecked = false;
      this.display();
    };

    if (s.allowNetwork) {
      const list = netCard.createDiv({ attr: { style: "margin-top:10px;" } });
      list.createEl("div", { text: "Доступно с других устройств:", attr: { style: S.hint } });
      if (!lan.length) {
        list.createEl("div", { text: "Активных сетевых интерфейсов не найдено (или все запрещены).", attr: { style: S.hint + "font-style:italic;" } });
      } else {
        for (const ip of lan) {
          const full = "http://" + ip + ":" + s.port;
          const el = list.createEl("code", { text: full, attr: { style: S.code + "cursor:pointer;" } });
          el.onclick = async () => {
            try { await navigator.clipboard.writeText(full); new Notice("Скопировано: " + full); }
            catch (_) { new Notice("Не удалось скопировать"); }
          };
          el.title = "Клик — скопировать";
        }
      }

      const excluded = new Set(s.excludedInterfaces || []);
      const ifaces = this.plugin.listInterfaces().filter((i) => !i.internal);
      if (ifaces.length) {
        const ifaceBox = netCard.createDiv({ attr: { style: "margin-top:12px;padding-top:10px;border-top:1px solid var(--background-modifier-border);" } });
        ifaceBox.createEl("div", { text: "Сетевые адаптеры", attr: { style: S.label + "font-size:13px;" } });
        ifaceBox.createEl("div", {
          text: "Снимите галочку, чтобы запретить доступ через этот адаптер (например, VPN или Docker).",
          attr: { style: S.hint },
        });

        for (const iface of ifaces) {
          const isExcluded = excluded.has(iface.name);
          const row = ifaceBox.createDiv({
            attr: { style: S.row + "margin-top:6px;padding:6px 8px;border-radius:6px;background:var(--background-primary);" },
          });
          const cb = row.createEl("input", { attr: { type: "checkbox" } });
          cb.checked = !isExcluded;

          row.createEl("span", {
            text: iface.name,
            attr: { style: "font-family:var(--font-monospace);font-weight:600;color:var(--text-normal);min-width:100px;" },
          });
          row.createEl("span", {
            text: iface.address,
            attr: { style: "font-family:var(--font-monospace);color:var(--text-muted);flex:1;" },
          });
          row.createEl("span", {
            text: isExcluded ? "заблокирован" : "разрешён",
            attr: {
              style: "font-size:11px;font-weight:600;color:" +
                (isExcluded ? "var(--text-error)" : "var(--text-success)") + ";",
            },
          });

          cb.onchange = async () => {
            const set = new Set(s.excludedInterfaces || []);
            if (cb.checked) set.delete(iface.name);
            else set.add(iface.name);
            s.excludedInterfaces = Array.from(set);
            await this.plugin.saveSettings();
            this.display();
          };
        }
      }

      const warn = netCard.createDiv({ attr: { style: "margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--background-modifier-error);color:var(--text-on-accent);font-size:12px;font-weight:600;" } });
      warn.setText("⚠️ Сервер доступен всей локальной сети. Токен — единственная защита.");
    }

    // ---------- SETTINGS ----------
    const settingsCard = containerEl.createDiv({ attr: { style: S.card } });
    settingsCard.createEl("div", { text: "Настройки", attr: { style: S.label } });
    settingsCard.createEl("div", { text: "Изменения применяются мгновенно.", attr: { style: S.hint } });

    const portRow = settingsCard.createDiv({ attr: { style: S.row + "margin-top:10px;" } });
    portRow.createEl("span", { text: "Порт сервера", attr: { style: "flex:1;color:var(--text-normal);" } });
    const portInput = portRow.createEl("input", {
      attr: { type: "number", value: String(s.port), style: "width:100px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);" },
    });
    portInput.onchange = async () => {
      const p = parseInt(portInput.value, 10);
      if (p > 0 && p < 65536) {
        s.port = p;
        await this.plugin.saveSettings();
        this.plugin.restartServer();
        this.statusOk = null;
        this._autoChecked = false;
        this.display();
      } else {
        new Notice("Некорректный порт");
        portInput.value = String(s.port);
      }
    };

    const sizeRow = settingsCard.createDiv({ attr: { style: S.row + "margin-top:8px;" } });
    sizeRow.createEl("span", { text: "Максимальный размер файла (МБ)", attr: { style: "flex:1;color:var(--text-normal);" } });
    const sizeInput = sizeRow.createEl("input", {
      attr: { type: "number", value: String(Math.round(s.maxFileSize / 1024 / 1024)), style: "width:100px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);" },
    });
    sizeInput.onchange = async () => {
      const mb = parseFloat(sizeInput.value);
      if (mb > 0) { s.maxFileSize = Math.floor(mb * 1024 * 1024); await this.plugin.saveSettings(); }
      else sizeInput.value = String(Math.round(s.maxFileSize / 1024 / 1024));
    };

    const rateRow = settingsCard.createDiv({ attr: { style: S.row + "margin-top:8px;" } });
    rateRow.createEl("span", { text: "Rate limit (запросов/мин на IP)", attr: { style: "flex:1;color:var(--text-normal);" } });
    const rateInput = rateRow.createEl("input", {
      attr: { type: "number", value: String(s.rateLimitPerMin), style: "width:100px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);" },
    });
    rateInput.onchange = async () => {
      const n = parseInt(rateInput.value, 10);
      if (n > 0) { s.rateLimitPerMin = n; await this.plugin.saveSettings(); }
    };

    const roRow = settingsCard.createDiv({ attr: { style: S.row + "margin-top:8px;" } });
    roRow.createEl("span", { text: "Только чтение (запретить PUT/POST/DELETE)", attr: { style: "flex:1;color:var(--text-normal);" } });
    const roToggle = roRow.createEl("input", { attr: { type: "checkbox" } });
    roToggle.checked = !!s.readOnly;
    roToggle.onchange = async () => {
      s.readOnly = roToggle.checked;
      await this.plugin.saveSettings();
      new Notice(s.readOnly ? "Read-only включён" : "Read-only выключен");
    };

    // ---------- QUICK START ----------
    const qsCard = containerEl.createDiv({ attr: { style: S.card } });
    qsCard.createEl("div", { text: "Быстрый старт", attr: { style: S.label } });
    qsCard.createEl("div", { text: "Проверка соединения из терминала или браузера.", attr: { style: S.hint } });

    const fullCurl = 'curl -H "Authorization: Bearer ' + s.token + '" ' + baseUrl + "/health";
    const shortToken = s.token.slice(0, 8) + "\u2026" + s.token.slice(-8);
    const displayCurl = 'curl -H "Authorization: Bearer ' + shortToken + '" ' + baseUrl + "/health";
    qsCard.createEl("code", { text: displayCurl, attr: { style: S.code } });
    qsCard.createEl("div", { text: "Токен в превью обрезан. Кнопка «Скопировать curl» вставит полный.", attr: { style: S.hint } });

    const actionRow = qsCard.createDiv({ attr: { style: S.row + "margin-top:10px;" } });

    const setBadge = (ok) => {
      const badge = this.containerEl.querySelector(".rest-api-status-badge");
      if (!badge) return;
      badge.textContent = ok ? "Работает" : "Не отвечает";
      badge.setAttribute("style", ok ? S.badgeOk : S.badgeErr);
    };

    const btnTest = actionRow.createEl("button", { text: "Проверить соединение", attr: { style: btnPrimary } });
    btnTest.onclick = async () => {
      btnTest.textContent = "Проверка...";
      btnTest.disabled = true;
      try {
        const res = await this.plugin.httpGetJson(loopbackUrl + "/health", {}, 3000);
        this.statusOk = res.ok && res.json && res.json.status === "ok";
        new Notice(this.statusOk ? "Сервер отвечает" : "Сервер ответил ошибкой " + res.status);
        setBadge(this.statusOk);
      } catch (e) {
        this.statusOk = false;
        new Notice("Сервер не отвечает: " + e.message);
        setBadge(false);
      } finally {
        btnTest.textContent = "Проверить соединение";
        btnTest.disabled = false;
      }
    };

    actionRow.createEl("button", { text: "Скопировать curl", attr: { style: btnNormal } }).onclick = async () => {
      try { await navigator.clipboard.writeText(fullCurl); new Notice("curl скопирован"); }
      catch (_) { new Notice("Не удалось скопировать"); }
    };

    actionRow.createEl("button", { text: "Открыть в браузере", attr: { style: btnNormal } }).onclick = () => {
      window.open(baseUrl + "/health", "_blank");
    };

    // ---------- ENDPOINTS ----------
    const epCard = containerEl.createDiv({ attr: { style: S.card } });
    const epHeader = epCard.createDiv({ attr: { style: "display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;" } });
    epHeader.createEl("div", { text: "Доступные эндпоинты", attr: { style: S.label } });
    const arrow = epHeader.createEl("span", { text: this.showEndpoints ? "\u25BC" : "\u25B6", attr: { style: "color:var(--text-muted);font-size:12px;" } });

    const endpoints = [
      ["GET",    "/health",                      "Статус плагина и количество файлов (без токена)"],
      ["GET",    "/capabilities",                "Что умеет плагин (batch, move, search, binary...)"],
      ["GET",    "/vault/{path}",                "Прочитать файл (raw text или binary по расширению)"],
      ["PUT",    "/vault/{path}",                "Записать файл: текст или бинарь (по расширению)"],
      ["POST",   "/vault/{path}",                "Дописать в конец файла (только текст)"],
      ["DELETE", "/vault/{path}",                "Удалить файл"],
      ["GET",    "/vault/{folder}/",             "Листинг папки"],
      ["POST",   "/upload",                      "Загрузить бинарник через JSON { path, content_base64 }"],
      ["POST",   "/batch/read",                  "Прочитать много файлов одним запросом"],
      ["POST",   "/batch/write",                 "Записать много файлов одним запросом"],
      ["POST",   "/batch/delete",                "Удалить много файлов"],
      ["POST",   "/batch/move",                  "Переместить много файлов"],
      ["GET",    "/tree",                        "Всё дерево папок и файлов (с hash/mtime)"],
      ["POST",   "/mkdir",                       "Создать папку (рекурсивно)"],
      ["DELETE", "/folder/{path}",               "Удалить папку (?recursive=1 или ?empty_only=1)"],
      ["POST",   "/rmdir",                       "Удалить пустые папки batch'ем"],
      ["GET",    "/search?q=...",                "Поиск по пути/содержимому со сниппетами"],
      ["POST",   "/search_by_tags",              "Поиск по тегам (frontmatter + inline)"],
      ["GET",    "/backlinks/{path}",            "Кто ссылается на файл"],
      ["GET",    "/outlinks/{path}",             "Ссылки из файла"],
      ["GET",    "/meta/{path}",                 "Frontmatter + hash + mtime + wikilinks + mime"],
    ];

    const epTableWrap = epCard.createDiv({ attr: { style: this.showEndpoints ? "" : "display:none;" } });
    const table = epTableWrap.createEl("table", { attr: { style: "width:100%;margin-top:10px;border-collapse:collapse;font-size:12px;" } });
    for (const [method, path, desc] of endpoints) {
      const tr = table.createEl("tr", { attr: { style: "border-bottom:1px solid var(--background-modifier-border);" } });
      const methodColor = method === "GET" ? "var(--text-success)" : method === "DELETE" ? "var(--text-error)" : "var(--text-accent)";
      tr.createEl("td", { text: method, attr: { style: "padding:5px 8px;font-family:var(--font-monospace);font-weight:600;color:" + methodColor + ";width:70px;" } });
      tr.createEl("td", { text: path, attr: { style: "padding:5px 8px;font-family:var(--font-monospace);color:var(--text-normal);width:220px;" } });
      tr.createEl("td", { text: desc, attr: { style: "padding:5px 8px;color:var(--text-muted);" } });
    }

    epHeader.onclick = () => {
      this.showEndpoints = !this.showEndpoints;
      epTableWrap.style.display = this.showEndpoints ? "" : "none";
      arrow.textContent = this.showEndpoints ? "\u25BC" : "\u25B6";
    };

    // ---------- CHECK STATUS ON OPEN ----------
    if (!this._autoChecked) {
      this._autoChecked = true;
      setTimeout(async () => {
        try {
          const res = await this.plugin.httpGetJson(loopbackUrl + "/health", {}, 3000);
          this.statusOk = res.ok && res.json && res.json.status === "ok";
        } catch (_) { this.statusOk = false; }
        setBadge(this.statusOk);
      }, 100);
    }
  }
}

module.exports = RestApiPlugin;
