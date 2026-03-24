const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT    = 3000;
const DB_FILE = path.join(__dirname, 'specs.json');

// ─── Timing constants ──────────────────────────────────────────────────
//
//  How it works:
//  1. Every message resets the 40s BATCH timer.
//  2. When 40s of silence → batch is auto-flushed and saved.
//  3. A separate 60s SESSION timer starts with the very first message ever.
//     → At 60s: server sends a nudge "Are you done?" with Yes/No buttons.
//     → YES → all batches in the session are grouped and final summary saved.
//     → NO  → continue; nudge re-fires every 60s until yes.
//  4. End keywords → instant flush + group.
//
const BATCH_SILENCE_MS = 40000;   // 40s of silence → flush one batch
const NUDGE_MS         = 60000;   // 60s after session start → ask "done?"

const END_KEYWORDS = [
  'done', "that's all", "that's it", 'end', 'finish',
  'complete', 'over', 'thats all', 'that is all'
];
// ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ sessions: {} }, null, 2));
}

function readDB()      { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// per-session state
const buffers       = {};
const pendingNudges = {};

function getBuffer(sid) {
  if (!buffers[sid]) {
    buffers[sid] = {
      messages:      [],      // current unflushed messages
      batchTimer:    null,    // 40s silence → flush batch
      nudgeTimer:    null,    // 60s → ask "are you done?"
      typingClear:   null,
      nudgeSent:     false,
      isTyping:      false,
      sessionStarted: false,  // has first message been sent?
      batchTimeMs:   BATCH_SILENCE_MS
    };
  }
  return buffers[sid];
}

// ─── Flush ONE batch ──────────────────────────────────────────────────
function flushBatch(sid, reason) {
  const buf = buffers[sid];
  if (!buf || buf.messages.length === 0) return null;

  clearTimeout(buf.batchTimer);
  buf.batchTimer = null;

  const db = readDB();
  if (!db.sessions[sid]) db.sessions[sid] = { batches: [], groupedAt: null, groupedCombined: null };

  const batch = {
    batchId:      db.sessions[sid].batches.length + 1,
    messages:     [...buf.messages],
    combined:     buf.messages.join(' '),
    flushReason:  reason,
    messageCount: buf.messages.length,
    batchMsUsed:  buf.batchTimeMs,
    savedAt:      new Date().toISOString()
  };

  db.sessions[sid].batches.push(batch);
  writeDB(db);
  buf.messages = [];

  console.log(`[BATCH] ${sid} | Batch #${batch.batchId} | trigger:${reason} | ${batch.messageCount} msgs`);
  return batch;
}

// ─── Group ALL batches into a session summary ─────────────────────────
function groupSession(sid, reason) {
  // First flush any pending messages as a final batch
  const lastBatch = flushBatch(sid, reason);

  const db = readDB();
  if (!db.sessions[sid]) return null;

  const batches = db.sessions[sid].batches;
  if (!batches.length) return null;

  const allMessages = batches.flatMap(b => b.messages);
  const groupedCombined = batches.map((b, i) =>
    `[Batch ${b.batchId}] ${b.combined}`
  ).join(' | ');

  db.sessions[sid].groupedAt       = new Date().toISOString();
  db.sessions[sid].groupedCombined = groupedCombined;
  db.sessions[sid].totalMessages   = allMessages.length;
  db.sessions[sid].totalBatches    = batches.length;
  db.sessions[sid].groupReason     = reason;
  writeDB(db);

  // Stop all timers
  const buf = buffers[sid];
  if (buf) {
    clearTimeout(buf.batchTimer);
    clearTimeout(buf.nudgeTimer);
    clearTimeout(buf.typingClear);
    buf.batchTimer   = null;
    buf.nudgeTimer   = null;
    buf.nudgeSent    = false;
    buf.sessionStarted = false;
  }
  delete pendingNudges[sid];

  console.log(`[GROUP] ${sid} | ${batches.length} batches grouped | trigger:${reason}`);
  return { lastBatch, grouped: db.sessions[sid] };
}

// ─── 40s Batch silence timer ──────────────────────────────────────────
function resetBatchTimer(sid) {
  const buf = getBuffer(sid);
  clearTimeout(buf.batchTimer);
  buf.batchTimer = setTimeout(() => {
    if (buf.isTyping) {
      buf.batchTimer = setTimeout(() => resetBatchTimer(sid), 3000);
      return;
    }
    // If nudge is pending, don't auto-flush — wait for user answer
    if (pendingNudges[sid]) {
      buf.batchTimer = setTimeout(() => resetBatchTimer(sid), 5000);
      return;
    }
    const batch = flushBatch(sid, 'silence_40s');
    if (batch) console.log(`[TIMER] Auto-flushed batch #${batch.batchId} after 40s silence`);
  }, buf.batchTimeMs);
}

// ─── 60s Nudge timer (fires once per session cycle) ──────────────────
function startNudgeTimer(sid) {
  const buf = getBuffer(sid);
  if (buf.nudgeTimer) return; // already running
  buf.nudgeTimer = setTimeout(() => {
    if (!buf.nudgeSent) {
      buf.nudgeSent      = true;
      pendingNudges[sid] = true;
      // Pause the batch timer — user must answer first
      clearTimeout(buf.batchTimer);
      buf.batchTimer = null;
      console.log(`[NUDGE] Firing for session ${sid}`);
    }
  }, NUDGE_MS);
}

// ─── HTTP Server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const p = url.parse(req.url, true);

  if (req.method === 'GET' && p.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  function body(cb) {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { cb(JSON.parse(b)); } catch(e) { res.writeHead(400); res.end(); } });
  }
  function json(d) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(d));
  }

  // POST /typing
  if (req.method === 'POST' && p.pathname === '/typing') {
    body(({ sessionId }) => {
      const buf = getBuffer(sessionId);
      buf.isTyping = true;
      clearTimeout(buf.typingClear);
      buf.typingClear = setTimeout(() => { buf.isTyping = false; }, 4000);
      json({ ok: true, batchMs: buf.batchTimeMs });
    });
    return;
  }

  // POST /message
  if (req.method === 'POST' && p.pathname === '/message') {
    body(({ sessionId, text }) => {
      const isEnd = END_KEYWORDS.includes(text.trim().toLowerCase());
      const buf   = getBuffer(sessionId);

      if (isEnd) {
        const result = groupSession(sessionId, 'keyword');
        return json({ status: 'grouped', trigger: 'keyword', result });
      }

      // Cancel any active nudge — user is still sending
      if (pendingNudges[sessionId]) {
        delete pendingNudges[sessionId];
        buf.nudgeSent = false;
        clearTimeout(buf.nudgeTimer);
        buf.nudgeTimer = null;
      }

      buf.isTyping = false;
      buf.messages.push(text.trim());

      // Start session-level nudge timer on FIRST ever message
      if (!buf.sessionStarted) {
        buf.sessionStarted = true;
        startNudgeTimer(sessionId);
      }

      // Reset 40s batch timer on every message
      resetBatchTimer(sessionId);

      json({ status: 'buffered', count: buf.messages.length, batchMs: buf.batchTimeMs });
    });
    return;
  }

  // POST /confirm — user answers yes/no to nudge
  if (req.method === 'POST' && p.pathname === '/confirm') {
    body(({ sessionId, answer }) => {
      delete pendingNudges[sessionId];
      const buf = getBuffer(sessionId);
      buf.nudgeSent  = false;
      clearTimeout(buf.nudgeTimer);
      buf.nudgeTimer = null;

      if (answer === 'yes') {
        const result = groupSession(sessionId, 'confirmed');
        return json({ status: 'grouped', result });
      }

      // Still going — restart both timers fresh
      resetBatchTimer(sessionId);
      startNudgeTimer(sessionId);
      json({ status: 'continuing', batchMs: buf.batchTimeMs });
    });
    return;
  }

  // POST /flush — manual save (saves current buffer as batch only, does NOT group)
  if (req.method === 'POST' && p.pathname === '/flush') {
    body(({ sessionId }) => {
      json({ status: 'ok', batch: flushBatch(sessionId, 'manual') });
    });
    return;
  }

  // POST /group — manual group all batches
  if (req.method === 'POST' && p.pathname === '/group') {
    body(({ sessionId }) => {
      const result = groupSession(sessionId, 'manual_group');
      json({ status: 'grouped', result });
    });
    return;
  }

  // GET /status
  if (req.method === 'GET' && p.pathname === '/status') {
    const sid = p.query.sessionId;
    const buf = buffers[sid];
    json({
      count:        buf ? buf.messages.length : 0,
      messages:     buf ? buf.messages : [],
      batchMs:      buf ? buf.batchTimeMs : BATCH_SILENCE_MS,
      nudgePending: !!(pendingNudges[sid]),
      isTyping:     buf ? buf.isTyping : false,
      sessionStarted: buf ? buf.sessionStarted : false
    });
    return;
  }

  // GET /specs
  if (req.method === 'GET' && p.pathname === '/specs') {
    const db = readDB();
    json(p.query.sessionId ? (db.sessions[p.query.sessionId] || { batches: [] }) : db);
    return;
  }

  // DELETE /specs
  if (req.method === 'DELETE' && p.pathname === '/specs') {
    const sid = p.query.sessionId;
    const db  = readDB();
    if (sid && db.sessions[sid]) delete db.sessions[sid];
    if (sid && buffers[sid]) {
      const b = buffers[sid];
      clearTimeout(b.batchTimer);
      clearTimeout(b.nudgeTimer);
      clearTimeout(b.typingClear);
      delete buffers[sid];
    }
    delete pendingNudges[sid];
    writeDB(db);
    json({ status: 'cleared' });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\nChat Aggregator → http://localhost:${PORT}`);
  console.log(`Specs saved to  → ${DB_FILE}`);
  console.log(`\nTimer logic:`);
  console.log(`  Batch silence : ${BATCH_SILENCE_MS/1000}s → auto-flush one batch`);
  console.log(`  Session nudge : ${NUDGE_MS/1000}s after first message → "Are you done?"`);
  console.log(`  On YES        → all batches grouped into one session summary\n`);
});
