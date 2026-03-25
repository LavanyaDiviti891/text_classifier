# Chat Spec Aggregator

A lightweight Node.js chat interface that collects product specification messages from a user, automatically batches them using silence timers, groups them into a session summary, and exports them — all without any external dependencies.

---

## Quick Start

```bash
# No npm install needed — uses only Node.js built-ins
node server.js
```

Open **http://localhost:3000** in your browser. Place `index.html` and `server.js` in the same folder.

---

## How It Works — Step by Step

```
User types messages
      │
      ▼
[SERVER buffers them in memory]
      │
      ├─── Every new message resets the 40s BATCH timer
      │
      ├─── 40s of silence → Batch flushed → saved to specs.json
      │         (a new batch starts fresh after this)
      │
      ├─── 60s after FIRST message → chatbot asks "Are you done?"
      │         YES → all batches grouped into one session summary
      │         NO  → timers restart for another round
      │
      └─── User types "done" / clicks Done ✓ → instant group + save
```

### The Two Timers

| Timer | Duration | Resets on? | What it does |
|-------|----------|------------|--------------|
| **Batch timer** (green bar) | 40s | Every new message | Flushes current messages as one numbered batch |
| **Session timer** (orange bar) | 60s | Never (one-shot per session) | Fires a chatbot nudge: *"Are you done?"* |

### Flush Triggers (what saves a batch)

| Trigger | How |
|---------|-----|
| `silence_40s` | User stops typing for 40 seconds |
| `keyword` | User types `done`, `finish`, `end`, `that's all`, etc. |
| `confirmed` | User clicks **Yes, save it ✓** on the 60s nudge |
| `manual` | User clicks **Save now (manual)** in the right panel |

---

## Project Structure

```
chat-aggregator/
├── server.js       ← Node.js HTTP server (no frameworks)
├── index.html      ← Frontend UI (vanilla JS, WhatsApp-style)
└── specs.json      ← Auto-created; stores all batches and sessions
```

---

## Key Code Sections

### server.js

| Section | What it does |
|---------|--------------|
| `getBuffer(sid)` | Creates/returns per-session state: messages, timers, flags |
| `flushBatch(sid, reason)` | Saves current buffered messages as a new batch to `specs.json` |
| `groupSession(sid, reason)` | Flushes any remaining messages then merges all batches into a grouped session summary |
| `resetBatchTimer(sid)` | Clears and restarts the 40s silence timer on every message |
| `startNudgeTimer(sid)` | Starts the one-shot 60s timer; fires once per session cycle |
| `readDB() / writeDB()` | Reads/writes `specs.json` synchronously using Node's `fs` module |

### index.html

| Section | What it does |
|---------|--------------|
| `startBatchTimer()` | Animates the green progress bar counting down 40s; resets on each message |
| `startSessionTimer()` | Animates the orange progress bar counting down 60s; starts once |
| `doSend(text)` | Core send function — buffers message, updates UI, posts to `/message` |
| `confirmNudge(answer)` | Handles yes/no response to the 60s chatbot nudge |
| `onGrouped(result)` | Called after session is grouped — stops timers, shows summary card |
| `pollStatus()` | Polls `/status` every 1.5s to detect server-side nudge trigger |
| `openExport()` | Opens the export modal, fetches latest specs, renders preview |
| `buildExportString(fmt)` | Builds JSON / Plain Text / Markdown export string from session data |

---

## API Reference

### `POST /message`
Send a user message to be buffered.

**Request:**
```json
{ "sessionId": "sess_abc12", "text": "It should be a mobile app" }
```

**Response (buffering):**
```json
{ "status": "buffered", "count": 3, "batchMs": 40000 }
```

**Response (end keyword triggered — session grouped):**
```json
{
  "status": "grouped",
  "trigger": "keyword",
  "result": {
    "lastBatch": { "batchId": 2, "messages": ["..."], "combined": "...", "flushReason": "keyword" },
    "grouped": {
      "batches": [...],
      "groupedCombined": "[Batch 1] msg1 msg2 | [Batch 2] msg3",
      "totalMessages": 5,
      "totalBatches": 2,
      "groupedAt": "2026-03-24T10:05:00.000Z",
      "groupReason": "keyword"
    }
  }
}
```

---

### `POST /confirm`
User answers the 60s nudge (yes/no).

**Request:**
```json
{ "sessionId": "sess_abc12", "answer": "yes" }
```

**Response (yes — grouped):**
```json
{
  "status": "grouped",
  "result": { "lastBatch": {...}, "grouped": {...} }
}
```

**Response (no — continuing):**
```json
{ "status": "continuing", "batchMs": 40000 }
```

---

### `POST /flush`
Manually save current buffer as a batch (does NOT group the session).

**Request:**
```json
{ "sessionId": "sess_abc12" }
```

**Response:**
```json
{
  "status": "ok",
  "batch": { "batchId": 1, "messages": ["..."], "combined": "...", "messageCount": 2, "flushReason": "manual", "savedAt": "..." }
}
```

---

### `POST /group`
Manually group all batches into a session summary.

**Request:**
```json
{ "sessionId": "sess_abc12" }
```

**Response:**
```json
{ "status": "grouped", "result": { "lastBatch": {...}, "grouped": {...} } }
```

---

### `POST /typing`
Frontend pings this every second while user is typing (prevents premature flush).

**Request:**
```json
{ "sessionId": "sess_abc12" }
```

**Response:**
```json
{ "ok": true, "batchMs": 40000 }
```

---

### `GET /status`
Frontend polls this every 1.5s to sync state and detect nudge.

**Response:**
```json
{
  "count": 3,
  "messages": ["msg1", "msg2", "msg3"],
  "batchMs": 40000,
  "nudgePending": false,
  "isTyping": false,
  "sessionStarted": true
}
```

---

### `GET /specs?sessionId=sess_abc12`
Fetch saved batches for a session.

**Response:**
```json
{
  "batches": [
    {
      "batchId": 1,
      "messages": ["It's a mobile app", "Needs dark mode"],
      "combined": "It's a mobile app Needs dark mode",
      "flushReason": "silence_40s",
      "messageCount": 2,
      "batchMsUsed": 40000,
      "savedAt": "2026-03-24T10:00:00.000Z"
    }
  ],
  "groupedCombined": "[Batch 1] It's a mobile app Needs dark mode",
  "groupedAt": "2026-03-24T10:01:05.000Z",
  "totalMessages": 2,
  "totalBatches": 1,
  "groupReason": "confirmed"
}
```

---

### `DELETE /specs?sessionId=sess_abc12`
Clear all data for a session (memory + file).

**Response:**
```json
{ "status": "cleared" }
```

---

## specs.json Structure

```json
{
  "sessions": {
    "sess_abc12": {
      "batches": [
        {
          "batchId": 1,
          "messages": ["It's a mobile app", "Needs dark mode"],
          "combined": "It's a mobile app Needs dark mode",
          "flushReason": "silence_40s",
          "messageCount": 2,
          "batchMsUsed": 40000,
          "savedAt": "2026-03-24T10:00:00.000Z"
        },
        {
          "batchId": 2,
          "messages": ["Budget is $50k", "Support 5 languages"],
          "combined": "Budget is $50k Support 5 languages",
          "flushReason": "confirmed",
          "messageCount": 2,
          "batchMsUsed": 40000,
          "savedAt": "2026-03-24T10:01:00.000Z"
        }
      ],
      "groupedAt": "2026-03-24T10:01:05.000Z",
      "groupedCombined": "[Batch 1] It's a mobile app Needs dark mode | [Batch 2] Budget is $50k Support 5 languages",
      "totalMessages": 4,
      "totalBatches": 2,
      "groupReason": "confirmed"
    }
  }
}
```

---

## Export Formats

Accessible via the **⬇ Export** button or the 📤 icon in the header.

| Format | File | Best for |
|--------|------|----------|
| **JSON** | `.json` | Feeding into another system or API |
| **Plain Text** | `.txt` | Quick readable summary |
| **Markdown** | `.md` | Notion, Obsidian, GitHub docs |

Scope options: **current session only** or **all sessions** in `specs.json`.

---

## End Keywords

Typing any of these instantly groups and saves the session:

`done` · `that's all` · `that's it` · `end` · `finish` · `complete` · `over` · `thats all` · `that is all`
