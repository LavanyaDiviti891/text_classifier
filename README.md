# Chat Spec Aggregator

Tracks split messages from a client and saves them as one batch locally.

## Setup

No dependencies needed — uses only Node.js built-ins.

```bash
cd chat-aggregator
node server.js
```

Then open http://localhost:3000 in your browser.

## How it works

1. Client sends messages one by one (split specs)
2. Server buffers them in memory per session
3. After 4 seconds of silence (or "done" keyword) → batch is flushed
4. Batch is saved to `specs.json` with all messages merged

## API

| Method | URL | Description |
|--------|-----|-------------|
| GET | / | Frontend UI |
| POST | /message | Send a message `{ sessionId, text }` |
| GET | /specs?sessionId=xxx | Get saved batches |
| DELETE | /specs?sessionId=xxx | Clear session data |

## Local storage file: specs.json

```json
{
  "sessions": {
    "session_abc123": {
      "batches": [
        {
          "batchId": 1,
          "messages": ["It's a mobile app", "Needs dark mode"],
          "combined": "It's a mobile app | Needs dark mode",
          "savedAt": "2026-03-23T10:00:00.000Z"
        }
      ]
    }
  }
}
```

## End keywords

Send any of these to force-flush the buffer immediately:
`done`, `that's all`, `that's it`, `end`, `finish`
