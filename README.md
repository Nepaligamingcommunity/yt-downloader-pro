# YT Downloader Pro 

> A self-hosted YouTube downloader with a browser-based UI, real-time progress tracking, batch queueing, and structured logging — powered by Node.js and yt-dlp.

---

## 🚀 Features

* **Video Downloads** — up to 4K (MP4, MKV, WEBM)
* **Audio Extraction** — MP3, M4A, OPUS, FLAC, WAV
* **Thumbnail Downloads** — WEBP, JPG, PNG
* **Real-time Progress** — live speed, ETA, percentage via WebSocket (`ws`)
* **Batch Queue System** — sequential processing with status tracking
* **Download History** — persistent (last 200 entries)
* **Structured Logging** — JSON logs with auto-rotation (5 MB)
* **Graceful Shutdown** — safely terminates active downloads
* **Pre-flight Checks** — verifies `yt-dlp` and `ffmpeg`
* **Configurable Settings** — rate limit, retries, cookies, archive, subtitles, etc.
* **Cross-platform Folder Opening**

---

## 📦 Requirements

| Dependency | Version | Install                                                              |
| ---------- | ------- | -------------------------------------------------------------------- |
| Node.js    | ≥ 18    | [https://nodejs.org](https://nodejs.org)                             |
| yt-dlp     | latest  | `pip install yt-dlp`                                                 |
| ffmpeg     | latest  | [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html) |

> ⚠️ Ensure **yt-dlp** and **ffmpeg** are added to your system PATH.

---

## ⚙️ Installation

```bash
# Clone repository
git clone https://github.com/Underscoore37/yt-downloader-pro-node.git
cd yt-downloader-pro-node

# Install dependencies
npm install

# Start server
node server.js
```

Open in browser:

```
http://localhost:3000
```

---

## 📁 Project Structure

```
yt-downloader-pro-node/
├── server.js
├── index.html
├── package.json
└── .ytdlp-web/
```

---

## 💾 Data Storage

```
./.ytdlp-web/
├── settings.json
├── history.json
├── archive.txt
├── cookies.txt
└── server.log
```

---

## 🔧 Configuration

Edit manually if needed:

```
./.ytdlp-web/settings.json
```

| Key                | Type    | Default                    | Description              |
| ------------------ | ------- | -------------------------- | ------------------------ |
| defaultDir         | string  | ~/Downloads                | Output directory         |
| defaultFormat      | string  | mp4                        | Video format             |
| defaultAudioFormat | string  | mp3                        | Audio format             |
| rateLimit          | string  | ""                         | Speed limit (e.g. 2M)    |
| retries            | number  | 3                          | Retry attempts           |
| concurrent         | number  | 2                          | Max concurrent downloads |
| sponsorblock       | boolean | false                      | Remove sponsor segments  |
| useCookies         | boolean | false                      | Enable cookies           |
| cookiesFile        | string  | `./.ytdlp-web/cookies.txt` | Cookie file path         |
| useArchive         | boolean | false                      | Skip downloaded videos   |
| embedSubs          | boolean | true                       | Embed subtitles          |
| embedChapters      | boolean | true                       | Embed chapters           |

---

## 🔐 Age-Restricted Videos

1. Export cookies using a browser extension
2. Save as:

```
./.ytdlp-web/cookies.txt
```

3. Enable **Use Cookies** in settings

---

## 🍪 Setup cookies.txt

1. **Install Extension:** Download [Get cookies.txt LOCALLY](https://chromewebstore.google.com/search/Get%20cookies.txt%20LOCALLY) from the Chrome Web Store.
2. **Export:** Click the extension icon in your browser bar and select **Export**.
3. **Configure:**
    * Locate the downloaded file in your `Downloads` folder.
    * Rename the file to `cookies.txt`.
    * Move it to the `/.ytdlp-web/` directory inside your project folder.

---

## 📡 API Reference

### REST Endpoints

| Method | Endpoint             | Description                         |
| ------ | -------------------- | ----------------------------------- |
| GET    | `/api/info?url=`     | Fetch video metadata                |
| GET    | `/api/formats?url=`  | Get available formats               |
| GET    | `/api/history`       | Retrieve history                    |
| DELETE | `/api/history`       | Clear history                       |
| DELETE | `/api/history/:id`   | Delete entry                        |
| GET    | `/api/settings`      | Get settings                        |
| POST   | `/api/settings`      | Update settings                     |
| POST   | `/api/cancel/:id`    | Cancel download                     |
| GET    | `/api/active`        | Active downloads                    |
| GET    | `/api/ytdlp-version` | yt-dlp version                      |
| POST   | `/api/update-ytdlp`  | Update yt-dlp                       |
| POST   | `/api/open-folder`   | Open output folder (cross-platform) |

---

### WebSocket

Connect to:

```
ws://localhost:3000
```

#### Start Download

```json
{
  "type": "download",
  "mode": "video",
  "url": "https://...",
  "options": {
    "quality": "1080p"
  }
}
```

#### Batch Queue

```json
{
  "type": "queue:run",
  "mode": "audio",
  "items": [
    { "url": "...", "title": "..." }
  ]
}
```

#### Events

* download:start
* download:progress
* download:log
* download:complete
* download:error
* download:cancelled
* queue:done

---

## 🔒 Security Notes

* No shell interpolation
* Strict settings validation
* Safe cancellation handling

---

## 🛑 Graceful Shutdown

Handles SIGINT and SIGTERM signals and safely terminates active downloads.

---

## 📜 License

MIT License

---

## 📬 Contact

Bigyan Pokharel
[contact@pokharelbigyan.com.np](mailto:contact@pokharelbigyan.com.np)
