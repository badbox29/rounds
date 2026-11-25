# Rounds — Daily Rounds Tracker

A to-do list for things that need touching every day, like a doctor's rounds. Add an item once, check in on it daily with a note (or just mark it seen), and archive it with its full history when it's done.

No build tools, no npm, no framework. Static files on GitHub Pages and a Cloudflare Worker for sync, using the same auth model as [Refectory](https://github.com/badbox29/refectory).

---

## Features

- **Today's rounds**: items you haven't checked in on today float to the top. Each card shows how long it's been open ("Day 12"), when you last checked in, and a preview of the latest note. Anything not seen since yesterday or earlier is flagged in red.
- **Daily notes**: tap an item, write a note, **Log note** (Cmd/Ctrl+Enter works too). **Seen, no notes** counts as a check-in when there's nothing to say. Notes build into a timeline per item.
- **Progress strip**: the header fills in one segment per item as you check in, with a "3 of 7 seen today" count.
- **Done & archive**: **Mark done & archive** moves an item to the Archive tab with all its notes. The archive is searchable by title and note text, and items can go back on rounds.
- **Undo** on check-ins, archiving, deleting and note removal. It still works after the change has synced.
- **Rename** and **delete** items, remove individual notes.
- **Copy backup**: Settings → Your data copies every item and note as JSON.
- **Light and dark mode** follow the system setting.

### Accounts and sync

- **Guest**: everything stays in this browser. Upgrade to an account at any time from Settings; guest items come with you.
- **Token**: a 128-bit token is your identity. Copy it from Settings to sign in on another device.
- **Google**: sign in with Google, either from the start or as a one-way upgrade from a token account.

Every synced account is **end-to-end encrypted** with a passphrase you choose. You enter it once per device; it never leaves the device, and your Worker only stores ciphertext. **If you forget it, synced data can't be recovered** — a device that still has the data can replace the synced copy under a new passphrase (Settings or "Forgot it?").

Sync is pull → merge → push, so a device that's been asleep can't write old data over newer data:

- Merging is **per item**: the most recent edit wins for the title and status. Notes from every device are **combined**, so a note logged on your phone and a rename on your desktop both survive.
- Deletions sync as **tombstones** (kept 180 days). An item edited after it was deleted — which is how Undo works — comes back.
- Changes push about 1.5 seconds after you make them, plus a background sync every minute, on hiding the tab, and when you come back to it.
- Offline edits are saved locally and flagged as unsynced until a push is confirmed. The sync pill in the header shows the state; tap it to sync now.

---

## File structure

```
rounds/
├── index.html          # App shell, account wizard, settings
├── css/styles.css      # All styles
├── js/
│   ├── auth.js         # Portable auth module (guest / token / Google), from Refectory
│   └── app.js          # Board, local storage, merge and sync
├── worker/worker.js    # Cloudflare Worker (deploy separately)
└── README.md
```

---

## Setup

### 1. Deploy the Cloudflare Worker

1. In [dash.cloudflare.com](https://dash.cloudflare.com) open **Workers & Pages** → **Create** → **Create Worker**. Name it (e.g. `rounds-worker`) and **Deploy**.
2. **Edit code**, paste the contents of `worker/worker.js`, and **Deploy** again. Note the URL, e.g. `https://rounds-worker.your-subdomain.workers.dev`.

### 2. Create the KV namespace

1. **Workers & Pages → KV → Create a namespace**, e.g. `rounds-kv`.
2. Worker → **Settings → Bindings → Add → KV Namespace**. Variable name **exactly** `ROUNDS_KV`, pick the namespace, **Deploy**.

### 3. Set environment variables

Worker → **Settings → Variables and Secrets**:

| Variable | Type | Value |
|---|---|---|
| `ALLOWED_ORIGINS` | Text | `https://badbox29.github.io` |
| `GOOGLE_CLIENT_ID` | Text | Your Google OAuth client ID (only needed for Google sign-in) |

`ALLOWED_ORIGINS` is the origin only, no path. Add `http://localhost:8080` (comma-separated) if you want to test locally.

### 4. Google sign-in (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**, or reuse Refectory's.
2. Under **Authorized JavaScript origins** add `https://badbox29.github.io`. No redirect URIs are needed; sign-in uses a popup.
3. Put the client ID in the Worker's `GOOGLE_CLIENT_ID`. It reaches the app through `/auth/config` and never sits in frontend code.

Reusing Refectory's client ID is fine: Rounds keeps its data in its own KV namespace, so the same Google account gets a separate Rounds account.

### 5. Publish the frontend

1. Create a `rounds` repo and push these files (the `worker/` folder can stay in the repo; it isn't served as part of the app).
2. **Settings → Pages**: deploy from the `main` branch, root folder.
3. The app will be at `https://badbox29.github.io/rounds/`.

**No Worker URL is built into the code.** Each browser stores its own, so anyone can open the same GitHub Pages site and point it at their own private Worker. The URL lives in that browser's `localStorage` and is never uploaded to the Worker or included in synced data. Set or change it in the setup wizard or in **Settings → Worker URL**. The Google client ID is fetched from whichever Worker the browser points at.

If someone else runs Rounds from your Pages site against their own Worker, they add `https://badbox29.github.io` to *their* Worker's `ALLOWED_ORIGINS`, and to their own Google OAuth client's authorized origins if they use Google sign-in.

> **Shared origin:** every app under `badbox29.github.io` shares one browser storage quota and one `localStorage`. Rounds prefixes all its keys with `rounds_` and uses its own write-key slot, so it won't collide with Refectory. Its data is tiny, but if a neighbouring app fills the quota Rounds shows a banner rather than silently losing writes.

### 6. First run

Open the app and choose **No — start fresh**, enter your Worker URL, then **Use Token** or **Link Google Account**. On other devices choose **Yes — load my existing account** and enter the same Worker URL.

---

## Security model

**What the Worker can see:** an account id, a few envelope fields (`format`, `authMethod`, `lastModified`, key-wrapping parameters) and ciphertext. Not your tasks, notes, names or token.

- **End-to-end encryption.** Data is encrypted in the browser with a random 256-bit data key (AES-GCM). The data key is wrapped with a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations, random salt), and the wrapped copy is stored alongside the ciphertext so any device with the passphrase can open it. Each device keeps the unwrapped data key in its own storage, so the passphrase is asked once per device. Changing the passphrase re-wraps the same data key; other devices pick up the change automatically.
- **Token accounts: the token never leaves the device.** The storage id is a SHA-256 fingerprint of the token (`r1…`), and requests are HMAC-signed with a key derived from the token (HKDF) that's registered with the Worker once. Neither reveals the token. Anyone with access to the Worker or its logs could overwrite or delete data, but not read it — tampering fails decryption.
- **Google accounts.** The Worker verifies the Google ID token (RS256 against Google's published keys) once, then mints a random per-account **write key** used to sign requests, so sync keeps working after the 1-hour Google token expires. **Sign out on all devices** in Settings deletes the write key. Google identifies *who* you are; your passphrase is still what protects the data.
- **Token → Google upgrade** requires a valid Google sign-in plus a request signed as the token account. The encrypted data moves as-is, so the passphrase keeps working. Afterwards the old account id returns `410 Gone`.
- CORS is locked to `ALLOWED_ORIGINS`. `/auth/*` routes are rate-limited per IP; storage is rate-limited per account.

**What it doesn't protect against:** someone with access to an unlocked device or browser profile (data, token and data key sit in the browser's storage), or a compromised copy of the app's own code — the page is trusted, and so is Google's sign-in script it loads.

`HMAC_SALT` (`rounds-hmac-v1`) must match in `worker/worker.js` and `js/app.js` and must never change after deployment.

### Upgrading from v2.0.x

Deploy the new `worker.js` and the new site files together; nothing else changes (same KV namespace and variables). Each existing account upgrades itself the next time it syncs:

1. A **token** account proves its token to the Worker one last time (`/auth/register` with `legacyToken`). The Worker moves its data to the fingerprint id and deletes every key that contained the raw token. Requests to the old raw-token address return `410`.
2. The app finds the old unencrypted copy and asks for a passphrase (**Encrypt your synced data**). Existing tasks and notes are encrypted with it and the plaintext copy on the Worker is overwritten.
3. Other devices are asked for the same passphrase on their next sync. Until a device sets or enters it, sync pauses there and nothing is uploaded; local data stays usable.

## Worker routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/`, `/ping` | Health check (open CORS, no auth) |
| `GET` | `/auth/config` | Google client ID |
| `POST` | `/auth/google` | Verify a Google ID token |
| `POST` | `/auth/verify` | Re-verify a stored Google credential at boot |
| `POST` | `/auth/writekey` | Mint/return the account's write key (Google) |
| `POST` | `/auth/revokekeys` | Delete the write key (signs out every device) |
| `POST` | `/auth/register` | Register a token account's signing key (and move a pre-v2.1 account) |
| `POST` | `/auth/migrate` | One-way token → Google migration |
| `GET` | `/storage/:token` | List keys |
| `GET` | `/storage/:token/:key` | Read a value |
| `PUT` | `/storage/:token/:key` | Write a value |
| `DELETE` | `/storage/:token/:key` | Delete a value |

## Data

One document per account at KV key `user:{accountId}:profile`, where `accountId` is `r1…` (token accounts) or `google:{sub}`. What the Worker stores:

```json
{
  "format": "rounds-e2e-v1",
  "authMethod": "token",
  "lastModified": 1764003600000,
  "keyId": "m3x9k2abc",
  "wrapAt": 1764000000000,
  "kdf":  { "name": "PBKDF2-SHA256", "iter": 600000, "salt": "…" },
  "wrap": { "iv": "…", "ct": "…" },
  "data": { "iv": "…", "ct": "…" }
}
```

Inside `data` (decrypted in the browser):

```json
{
  "items": {
    "m3x9k2abc": {
      "id": "m3x9k2abc",
      "title": "Vendor quote — firewall",
      "createdAt": 1764000000000,
      "updatedAt": 1764003600000,
      "status": "active",
      "notes": [{ "id": "m3xa0fz12", "at": 1764003600000, "text": "Called rep, waiting on pricing." }],
      "deletedNotes": []
    }
  },
  "tombstones": { "m3w1q8xyz": 1763990000000 },
  "lastModified": 1764003600000
}
```

`status` is `"active"` or `"done"` (with `doneAt`). An empty `text` is a "seen, no notes" check-in. The token, Worker URL and account type are kept on the device only.
