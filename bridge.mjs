#!/usr/bin/env node
// agent2wechat — bridges an AI agent to WeChat via Tencent's official iLink Bot API
// (the same protocol the official openclaw-weixin plugin uses).
//
// Design:
// - Outbound HTTPS only. No listening ports.
// - Long-polls ilink/bot/getupdates; inbound messages from the bound owner are
//   written as JSON files into ./inbox for the agent to process.
// - Replies are picked up from ./outbox and sent via ilink/bot/sendmessage with
//   the conversation's latest context_token.
// - Credentials/state live in ./state.json (chmod 600). Never log the token.
//
// Commands:
//   node bridge.mjs login   QR-code login flow (writes login/qr.json, polls status)
//   node bridge.mjs run     Daemon: poll + deliver inbox, flush outbox
//   node bridge.mjs status  Print current status summary
//   node bridge.mjs send    Send one reply file manually: send <outbox-file>

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(DIR, "state.json");
const STATUS_PATH = path.join(DIR, "status.json");
const INBOX = path.join(DIR, "inbox");
const MEDIA_IN = path.join(DIR, "media-in");
const OUTBOX = path.join(DIR, "outbox");
const SENT = path.join(DIR, "sent");
const FAILED = path.join(DIR, "failed");
const ALERTS = path.join(DIR, "alerts");
const LOGIN_DIR = path.join(DIR, "login");
const LOG_PATH = path.join(DIR, "logs", "bridge.log");

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "2.4.8";
const BOT_AGENT = "agent2wechat/1.0";
const APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 8); // 0x00MMNNPP for 2.4.8
const UIN = Buffer.from(String(crypto.randomInt(0, 0xffffffff))).toString("base64");
const TEXT_CHUNK = 3500;

for (const d of [INBOX, MEDIA_IN, OUTBOX, SENT, FAILED, ALERTS, LOGIN_DIR, path.dirname(LOG_PATH)]) {
  fs.mkdirSync(d, { recursive: true });
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5_000_000) {
      fs.writeFileSync(LOG_PATH, "");
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      bot_token: "",
      baseurl: DEFAULT_BASE,
      ilink_bot_id: "",
      owner_user_id: "",
      get_updates_buf: "",
      last_context_token: "",
      last_context_at: 0,
      seen_ids: [],
      auth_status: "not_logged_in",
    };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE_PATH, 0o600);
}

function writeStatus(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8")); } catch {}
  const next = { ...cur, ...patch, updated_at: new Date().toISOString(), pid: process.pid };
  fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
}

function appHeaders() {
  return { "iLink-App-Id": "bot", "iLink-App-ClientVersion": APP_CLIENT_VERSION };
}

function jsonHeaders(withAuth, state) {
  const h = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": UIN,
    ...appHeaders(),
  };
  if (withAuth && state?.bot_token) h.Authorization = `Bearer ${state.bot_token}`;
  return h;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function postJson(base, p, body, headers, timeoutMs = 50000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${p}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { http: res.status, json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

// ---------- QR login ----------

async function login() {
  const state = loadState();
  const localTokens = state.bot_token ? [state.bot_token] : [];
  log("Requesting QR code ...");
  const qrRes = await postJson(
    DEFAULT_BASE,
    "/ilink/bot/get_bot_qrcode?bot_type=3",
    { local_token_list: localTokens },
    jsonHeaders(false, state),
    30000
  );
  if (!qrRes.json?.qrcode) {
    log("Failed to get QR code:", qrRes.raw.slice(0, 300));
    process.exitCode = 1;
    return;
  }
  const { qrcode, qrcode_img_content } = qrRes.json;
  fs.writeFileSync(
    path.join(LOGIN_DIR, "qr.json"),
    JSON.stringify(
      { qrcode, qrcode_img_content, created_at: new Date().toISOString() },
      null,
      2
    )
  );
  log("QR code ready in login/qr.json — waiting for scan ...");

  let pollBase = DEFAULT_BASE;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let url = `${pollBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const verifyPath = path.join(LOGIN_DIR, "verify.txt");
    if (fs.existsSync(verifyPath)) {
      const code = fs.readFileSync(verifyPath, "utf8").trim();
      if (code) url += `&verify_code=${encodeURIComponent(code)}`;
    }
    let st = null;
    try {
      const res = await fetch(url, { headers: appHeaders() });
      st = await res.json();
    } catch {
      continue; // treat network failure as "wait"
    }
    const safeStatus = { ...st, bot_token: st.bot_token ? "<redacted>" : undefined };
    fs.writeFileSync(path.join(LOGIN_DIR, "status.json"), JSON.stringify(safeStatus, null, 2));
    if (st.status === "confirmed") {
      const s = loadState();
      s.bot_token = st.bot_token || "";
      s.baseurl = st.baseurl || DEFAULT_BASE;
      s.ilink_bot_id = st.ilink_bot_id || "";
      s.owner_user_id = st.ilink_user_id || "";
      s.get_updates_buf = "";
      s.seen_ids = [];
      s.auth_status = "ok";
      saveState(s);
      log(`Login confirmed. Owner bound: ${s.owner_user_id || "(unknown)"}`);
      return;
    }
    if (st.status === "scaned_but_redirect" && st.redirect_host) {
      pollBase = st.redirect_host.startsWith("http") ? st.redirect_host : `https://${st.redirect_host}`;
      log("Redirected QR polling to", pollBase);
    }
    if (st.status === "expired" || st.status === "verify_code_blocked") {
      log("QR flow ended with status:", st.status);
      process.exitCode = 2;
      return;
    }
    if (st.status === "need_verifycode") {
      log("Waiting for verify code (write it to login/verify.txt) ...");
    }
  }
  log("QR login timed out after 5 minutes.");
  process.exitCode = 3;
}

// ---------- Sending ----------

function chunkText(text) {
  const chunks = [];
  let rest = String(text ?? "");
  while (rest.length > TEXT_CHUNK) {
    let cut = rest.lastIndexOf("\n", TEXT_CHUNK);
    if (cut < TEXT_CHUNK * 0.5) cut = TEXT_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [""];
}

async function postSendMessage(state, toUserId, contextToken, itemList) {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2,
      message_state: 2,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: itemList,
    },
    base_info: baseInfo(),
  };
  const res = await postJson(state.baseurl || DEFAULT_BASE, "/ilink/bot/sendmessage", body, jsonHeaders(true, state), 60000);
  if (res.json && typeof res.json.ret === "number" && res.json.ret !== 0) {
    throw new Error(`sendmessage ret=${res.json.ret} errmsg=${res.json.errmsg || ""}`);
  }
  if (res.http !== 200) throw new Error(`sendmessage http=${res.http}`);
}

async function sendText(state, toUserId, contextToken, text) {
  for (const chunk of chunkText(text)) {
    await postSendMessage(state, toUserId, contextToken, [{ type: 1, text_item: { text: chunk } }]);
  }
}

// ---------- Media (CDN + AES-128-ECB) ----------

function aesEncrypt(buf, key) {
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(buf), c.final()]);
}

function aesDecrypt(buf, key) {
  const d = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(buf), d.final()]);
}

// Inbound keys arrive as: item.aeskey (32-char hex string) or media.aes_key
// (base64 of either the 16 raw key bytes or of the 32-char hex string).
function decodeInboundKey(itemBody) {
  if (itemBody?.aeskey && /^[0-9a-fA-F]{32}$/.test(itemBody.aeskey)) {
    return Buffer.from(itemBody.aeskey, "hex");
  }
  const b64 = itemBody?.media?.aes_key;
  if (b64) {
    const raw = Buffer.from(b64, "base64");
    if (raw.length === 16) return raw;
    const asText = raw.toString("utf8");
    if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, "hex");
  }
  return null;
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

function mediaKindForPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: "image", mediaType: 1, itemType: 2 };
  if (VIDEO_EXTS.has(ext)) return { kind: "video", mediaType: 2, itemType: 5 };
  return { kind: "file", mediaType: 3, itemType: 4 };
}

async function uploadMedia(state, toUserId, filePath) {
  const plain = fs.readFileSync(filePath);
  const { kind, mediaType } = mediaKindForPath(filePath);
  const key = crypto.randomBytes(16);
  const aeskeyHex = key.toString("hex");
  const cipher = aesEncrypt(plain, key);
  const filekey = crypto.randomUUID();
  const body = {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: plain.length,
    rawfilemd5: crypto.createHash("md5").update(plain).digest("hex"),
    filesize: cipher.length,
    no_need_thumb: true,
    aeskey: aeskeyHex,
    base_info: baseInfo(),
  };
  const res = await postJson(state.baseurl || DEFAULT_BASE, "/ilink/bot/getuploadurl", body, jsonHeaders(true, state), 30000);
  const up = res.json || {};
  let uploadUrl = up.upload_full_url || "";
  if (!uploadUrl && up.upload_param) {
    uploadUrl = `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  }
  if (!uploadUrl) throw new Error(`getuploadurl: no upload url (http=${res.http})`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  let upRes;
  try {
    upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: cipher,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const downloadParam = upRes.headers.get("x-encrypted-param");
  if (upRes.status !== 200 || !downloadParam) {
    throw new Error(`cdn upload failed http=${upRes.status} param=${downloadParam ? "yes" : "no"}`);
  }
  const mediaRef = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskeyHex, "utf8").toString("base64"),
    encrypt_type: 1,
  };
  return { kind, mediaRef, plainSize: plain.length, cipherSize: cipher.length };
}

async function sendMedia(state, toUserId, contextToken, filePath) {
  const { kind, mediaRef, plainSize, cipherSize } = await uploadMedia(state, toUserId, filePath);
  let item;
  if (kind === "image") {
    item = { type: 2, image_item: { media: mediaRef, mid_size: cipherSize } };
  } else if (kind === "video") {
    item = { type: 5, video_item: { media: mediaRef, video_size: cipherSize } };
  } else {
    item = {
      type: 4,
      file_item: { media: mediaRef, file_name: path.basename(filePath), len: String(plainSize) },
    };
  }
  await postSendMessage(state, toUserId, contextToken, [item]);
}

async function downloadInboundMedia(msgId, idx, item) {
  const bodies = { 2: item.image_item, 4: item.file_item, 5: item.video_item };
  const body = bodies[item.type];
  if (!body?.media?.encrypt_query_param && !body?.media?.full_url) return null;
  const key = decodeInboundKey(body);
  const url =
    body.media.full_url ||
    `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(body.media.encrypt_query_param)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (res.status !== 200) throw new Error(`cdn download http=${res.status}`);
  let data = Buffer.from(await res.arrayBuffer());
  if (key) {
    try { data = aesDecrypt(data, key); } catch { /* keep raw bytes if decrypt fails */ }
  }
  const kind = item.type === 2 ? "image" : item.type === 5 ? "video" : "file";
  let name = body.file_name ? path.basename(body.file_name) : "";
  if (!name) name = `${msgId}-${idx}.${kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin"}`;
  const safe = name.replace(/[^\w.\- ]/g, "_");
  const outPath = path.join(MEDIA_IN, `${msgId}-${idx}-${safe}`);
  fs.writeFileSync(outPath, data);
  return { kind, path: outPath, file_name: safe, size: data.length };
}

// ---------- Daemon ----------

function extractText(msg) {
  const parts = [];
  for (const item of msg.item_list || []) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text);
    else if (item.type === 3 && item.voice_item?.text) parts.push(item.voice_item.text);
  }
  return parts.join("\n").trim();
}

function raiseAlert(kind, detail) {
  const name = `${kind}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(ALERTS, name),
    JSON.stringify({ kind, detail, at: new Date().toISOString() }, null, 2)
  );
  log("ALERT:", kind, detail || "");
}

async function flushOutbox(state) {
  const files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const p = path.join(OUTBOX, f);
    let job;
    try { job = JSON.parse(fs.readFileSync(p, "utf8")); } catch { fs.renameSync(p, path.join(FAILED, f)); continue; }
    const to = job.to_user_id || state.owner_user_id;
    const token = job.context_token || state.last_context_token;
    try {
      if (job.text) await sendText(state, to, token, job.text);
      for (const att of job.attachments || []) {
        if (typeof att !== "string" || !att.startsWith("/home/hatch/") || !fs.existsSync(att)) {
          log("Skipped invalid attachment:", String(att));
          continue;
        }
        await sendMedia(state, to, token, att);
        log(`Sent attachment ${att}`);
      }
      fs.renameSync(p, path.join(SENT, f));
      log(`Sent reply ${f} (${(job.text || "").length} chars)`);
    } catch (e) {
      log("Send failed:", f, String(e.message || e));
      if (String(e.message || "").includes("ret=-14")) {
        state.auth_status = "expired";
        saveState(state);
        raiseAlert("auth-expired", "sendmessage returned -14");
      }
      fs.renameSync(p, path.join(FAILED, f));
    }
  }
}

async function run() {
  log("Bridge daemon starting ...");
  writeStatus({ auth_status: loadState().auth_status, mode: "run" });
  let backoff = 2000;
  for (;;) {
    const state = loadState();
    if (!state.bot_token) {
      writeStatus({ auth_status: "not_logged_in" });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (state.auth_status === "expired") {
      writeStatus({ auth_status: "expired" });
      // Idle until credentials change (a fresh login rewrites state.json).
      const before = fs.statSync(STATE_PATH).mtimeMs;
      await new Promise((r) => setTimeout(r, 5000));
      if (fs.statSync(STATE_PATH).mtimeMs !== before) log("Credentials changed, resuming.");
      continue;
    }
    try {
      await flushOutbox(state);
      const timeoutGuess = 45000;
      const res = await postJson(
        state.baseurl || DEFAULT_BASE,
        "/ilink/bot/getupdates",
        { get_updates_buf: state.get_updates_buf || "", base_info: baseInfo() },
        jsonHeaders(true, state),
        timeoutGuess
      );
      const j = res.json || {};
      const code = typeof j.errcode === "number" ? j.errcode : j.ret;
      if (code === -14) {
        state.auth_status = "expired";
        saveState(state);
        raiseAlert("auth-expired", "getupdates returned -14 (session expired, re-scan needed)");
        writeStatus({ auth_status: "expired" });
        continue;
      }
      if (typeof j.ret === "number" && j.ret !== 0) throw new Error(`getupdates ret=${j.ret} ${j.errmsg || ""}`);
      backoff = 2000;
      if (j.get_updates_buf) {
        state.get_updates_buf = j.get_updates_buf;
      }
      const seen = new Set(state.seen_ids || []);
      for (const msg of j.msgs || []) {
        const id = String(msg.message_id ?? `${msg.seq}-${msg.create_time_ms}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (msg.message_type !== 1) continue; // only user messages
        if (msg.group_id) continue; // direct chats only
        if (state.owner_user_id && msg.from_user_id !== state.owner_user_id) {
          log(`Ignored message from non-owner ${msg.from_user_id}`);
          continue;
        }
        const text = extractText(msg);
        if (msg.context_token) {
          state.last_context_token = msg.context_token;
          state.last_context_at = Date.now();
        }
        const mediaFiles = [];
        const items = msg.item_list || [];
        for (let i = 0; i < items.length; i++) {
          if ([2, 4, 5].includes(items[i].type)) {
            try {
              const mf = await downloadInboundMedia(id, i, items[i]);
              if (mf) {
                mediaFiles.push(mf);
                log(`Downloaded inbound media: ${mf.kind} ${mf.file_name} (${mf.size} bytes)`);
              }
            } catch (e) {
              log("Inbound media download failed:", String(e.message || e));
            }
          }
        }
        const record = {
          id,
          from_user_id: msg.from_user_id,
          text,
          has_media: items.some((i) => [2, 4, 5].includes(i.type)),
          media_files: mediaFiles,
          raw_items: items,
          context_token: msg.context_token || "",
          create_time_ms: msg.create_time_ms || null,
          received_at: new Date().toISOString(),
        };
        const fname = `${Date.now()}-${id.replace(/[^\w-]/g, "")}.json`;
        fs.writeFileSync(path.join(INBOX, fname), JSON.stringify(record, null, 2));
        log(`Inbox: message ${id} from owner (${text.length} chars)`);
      }
      state.seen_ids = [...seen].slice(-300);
      saveState(state);
      writeStatus({ auth_status: "ok", last_poll_at: new Date().toISOString() });
    } catch (e) {
      if (e.name === "AbortError") continue; // long-poll timeout: repoll immediately
      log("Poll error:", String(e.message || e), `backing off ${backoff}ms`);
      writeStatus({ auth_status: state.auth_status, last_error: String(e.message || e) });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// ---------- Main ----------

const cmd = process.argv[2] || "status";
if (cmd === "login") {
  await login();
} else if (cmd === "send-file") {
  const s = loadState();
  if (!s.bot_token) { console.error("not logged in"); process.exitCode = 1; }
  else {
    await sendMedia(s, s.owner_user_id, s.last_context_token, process.argv[3]);
    console.log("sent", process.argv[3]);
  }
} else if (cmd === "run") {
  await run();
} else if (cmd === "status") {
  const s = loadState();
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8")); } catch {}
  console.log(JSON.stringify({
    logged_in: !!s.bot_token,
    auth_status: s.auth_status,
    owner_bound: !!s.owner_user_id,
    baseurl: s.baseurl,
    inbox_pending: fs.readdirSync(INBOX).length,
    outbox_pending: fs.readdirSync(OUTBOX).length,
    daemon: st,
  }, null, 2));
} else {
  console.error("Unknown command:", cmd);
  process.exitCode = 1;
}
