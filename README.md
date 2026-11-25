# ⚡ Ares Cloud Engine — Distributed Media & AI Processing Node

On-demand **4 vCPU / 16 GB RAM / 10 Gbps** cloud media engine powered by GitHub Actions, `whisper.cpp`, `FFmpeg`, `yt-dlp`, and `LRCLIB`, secured end-to-end with **AES-256-GCM** encrypted bus transfers.

## 🛠️ Capabilities
- **Video Repair & Smart Compressor (`fixvideo` / `compress`)**: Converts unplayable/fragmented videos (`VP9`, `HEVC`, `AV1`, `10-bit`, `DASH/CMAF`, `MKV`, `WebM`, `MOV`) into universally playable `H.264/AAC MP4 (+faststart)` with smart compression presets (`720p`, `1080p`, `orig`, `480p`, `targetMB`, `fast`, `remux`).
- **AI Whisper (`whisper v` / `whisper`)**: Speech-to-text transcription + word-timed ASS subtitle burning (`7 cinematic themes`).
- **Synced Karaoke (`songs` / `mv`)**: LRCLIB synced lyrics + 1080p YouTube video/audio matching + FFmpeg ASS hardsubbing.
- **Audio & Video Studio**:
  - `slow` / `sped` (Pitch-coupled `asetrate` + `setpts` slowed+reverb / nightcore)
  - `cut` (Precision video/audio trimming)
  - `rotate` (90° / 180° / 270° / flip / mirror)
  - `setaudio` / `mixaudio` (Audio replacement & dual-stream mixing)
  - `mp3` (320kbps MP3 extraction)
  - `theme` (ASS subtitle style preview generator)
