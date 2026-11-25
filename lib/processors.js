const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const axios = require('axios');
const yts = require('yt-search');
const execFilePromise = util.promisify(execFile);

const {
    burnSubtitleIntoVideo,
    lrcToAss,
    probeVideoDimensions,
    renderThemePreview
} = require('./subtitleService');
const {
    fetchLyricsFromLRCLIB,
    findBestYouTubeMatch
} = require('./lrcService');

const TEMP_DIR = '/tmp/ares_work';
fs.mkdirSync(TEMP_DIR, { recursive: true });

function cleanupPrefixFiles(prefix, keepPaths = []) {
    try {
        const dir = path.dirname(prefix);
        const base = path.basename(prefix);
        const keepSet = new Set(keepPaths.filter(Boolean).map(p => path.resolve(p)));
        for (const f of fs.readdirSync(dir)) {
            if (!f.startsWith(base)) continue;
            const full = path.resolve(path.join(dir, f));
            if (keepSet.has(full)) continue;
            try { fs.unlinkSync(full); } catch (_) {}
        }
    } catch (_) {}
}

function getCookiesFile() {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 20) {
        return cookiesPath;
    }
    return null;
}

function getMediaDuration(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        let data = '';
        proc.stdout.on('data', chunk => { data += chunk.toString(); });
        proc.on('close', () => {
            const dur = parseFloat(data.trim());
            resolve(isNaN(dur) ? null : dur);
        });
        proc.on('error', () => resolve(null));
    });
}

function hasAudioStream(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        let data = '';
        proc.stdout.on('data', chunk => { data += chunk.toString(); });
        proc.on('close', () => resolve(data.trim().length > 0));
        proc.on('error', () => resolve(false));
    });
}

function getAudioSampleRate(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=sample_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        let data = '';
        proc.stdout.on('data', chunk => { data += chunk.toString(); });
        proc.on('close', () => {
            const sr = parseInt(data.trim(), 10);
            resolve(isNaN(sr) || sr <= 0 ? 44100 : sr);
        });
        proc.on('error', () => resolve(44100));
    });
}

function probeVideoFull(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=format_name,duration,size,bit_rate:stream=index,codec_type,codec_name,codec_tag_string,pix_fmt,width,height,r_frame_rate,avg_frame_rate,channels:stream_tags=rotate',
            '-show_entries', 'stream_side_data=rotation',
            '-of', 'json',
            filePath
        ]);
        let stdout = '';
        proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
        proc.on('close', () => {
            let sizeBytes = 0;
            try { sizeBytes = fs.statSync(filePath).size; } catch (_) {}
            try {
                const parsed = JSON.parse(stdout || '{}');
                const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
                const format = parsed.format || {};
                const vStream = streams.find(s => s.codec_type === 'video') || null;
                const aStream = streams.find(s => s.codec_type === 'audio') || null;

                let width = parseInt(vStream?.width, 10) || 0;
                let height = parseInt(vStream?.height, 10) || 0;
                let rotation = parseInt(vStream?.tags?.rotate, 10) || 0;
                if (!rotation && Array.isArray(vStream?.side_data_list)) {
                    const sd = vStream.side_data_list.find(d => d.rotation !== undefined);
                    if (sd) rotation = parseInt(sd.rotation, 10) || 0;
                }
                if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
                    const tmp = width;
                    width = height;
                    height = tmp;
                }

                const duration = parseFloat(format.duration || vStream?.duration) || 0;
                resolve({
                    hasVideo: Boolean(vStream),
                    hasAudio: Boolean(aStream),
                    vCodec: (vStream?.codec_name || 'unknown').toLowerCase(),
                    pixFmt: (vStream?.pix_fmt || 'unknown').toLowerCase(),
                    aCodec: (aStream?.codec_name || '').toLowerCase(),
                    aChannels: parseInt(aStream?.channels, 10) || 0,
                    formatName: (format.format_name || '').toLowerCase(),
                    width,
                    height,
                    duration,
                    sizeBytes
                });
            } catch (_) {
                resolve({
                    hasVideo: false,
                    hasAudio: false,
                    vCodec: 'unknown',
                    pixFmt: 'unknown',
                    aCodec: '',
                    aChannels: 0,
                    formatName: '',
                    width: 0,
                    height: 0,
                    duration: 0,
                    sizeBytes
                });
            }
        });
        proc.on('error', () => {
            let sizeBytes = 0;
            try { sizeBytes = fs.statSync(filePath).size; } catch (_) {}
            resolve({ hasVideo: false, hasAudio: false, sizeBytes, duration: 0, width: 0, height: 0, vCodec: 'unknown', pixFmt: 'unknown', aCodec: '', aChannels: 0 });
        });
    });
}

function runFfmpegWithProgress({ args, outPath, inDuration, targetDurationFactor = 1.0, onProgress }) {
    return new Promise((resolve, reject) => {
        const targetDuration = inDuration && inDuration > 0 ? (inDuration * targetDurationFactor) : null;
        const ffArgs = [...args, '-threads', '0', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', outPath];
        const proc = spawn('ffmpeg', ffArgs);

        let stdoutBuf = '';
        let stderrBuf = '';
        proc.stderr.on('data', chunk => {
            stderrBuf = (stderrBuf + chunk.toString()).slice(-1500);
        });
        proc.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop();
            let outTimeUs = null;
            let speed = null;
            for (const line of lines) {
                const idx = line.indexOf('=');
                if (idx === -1) continue;
                const k = line.slice(0, idx).trim();
                const v = line.slice(idx + 1).trim();
                if (k === 'out_time_us') outTimeUs = parseInt(v, 10);
                else if (k === 'speed') speed = v;
            }
            if (typeof onProgress === 'function' && outTimeUs !== null && !isNaN(outTimeUs)) {
                const currentSec = outTimeUs / 1000000;
                let percent = 50;
                if (targetDuration && targetDuration > 0) {
                    percent = Math.min(99, Math.max(1, Math.round((currentSec / targetDuration) * 100)));
                }
                onProgress({ percent, currentSec, targetDuration, speed: speed && speed !== 'N/A' ? speed : null });
            }
        });

        proc.on('close', code => {
            if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
                resolve(outPath);
            } else {
                try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
                const detail = stderrBuf.trim().split('\n').slice(-2).join(' ');
                reject(new Error(detail ? `FFmpeg exited (${code}): ${detail}` : `FFmpeg exited with code ${code}`));
            }
        });
        proc.on('error', err => {
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
            reject(err);
        });
    });
}

async function runYtDlpSmart(url, outFile, mode = 'video') {
    const cookiesFile = getCookiesFile();
    const baseArgs = mode === 'audio'
        ? ['-x', '--audio-format', 'mp3', '--audio-quality', '320k']
        : ['-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--format-sort', 'res:1080,res,vcodec:avc,size,tbr', '--merge-output-format', 'mp4'];

    const strategies = [
        [...(cookiesFile ? ['--cookies', cookiesFile] : []), '--js-runtimes', 'node', '--remote-components', 'ejs:github'],
        ['--js-runtimes', 'node', '--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=ios,android_vr,mweb'],
        [...(cookiesFile ? ['--cookies', cookiesFile] : []), '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=mweb,tv_embedded,web_creator']
    ];

    let lastErr = null;
    for (const strat of strategies) {
        try {
            if (fs.existsSync(outFile)) {
                try { fs.unlinkSync(outFile); } catch (_) {}
            }
            const args = [...strat, '--no-check-certificates', '--geo-bypass', '--no-playlist', ...baseArgs, '-o', outFile, url];
            await execFilePromise('yt-dlp', args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
                return outFile;
            }
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('Failed to download media from URL.');
}

async function resolveInputMedia(inputSpec, outPrefix, onProgress) {
    if (inputSpec && fs.existsSync(inputSpec)) {
        return inputSpec;
    }
    if (typeof inputSpec === 'string' && /^https?:\/\//i.test(inputSpec)) {
        await onProgress({ stage: 'Downloading Media (10Gbps Cloud)', percent: 15, detail: inputSpec });
        const isImg = /\.(jpe?g|png|webp|bmp)($|\?)/i.test(inputSpec);
        if (isImg) {
            const imgPath = `${outPrefix}_in.jpg`;
            const res = await axios.get(inputSpec, { responseType: 'arraybuffer', timeout: 30000 });
            fs.writeFileSync(imgPath, Buffer.from(res.data));
            return imgPath;
        }
        const outFile = `${outPrefix}_dl.mp4`;
        return await runYtDlpSmart(inputSpec, outFile, 'video');
    }
    throw new Error('Invalid or missing media input.');
}

// ============================================================================
// 1. WHISPER V (Burn Subtitles) & WHISPER TEXT (Transcribe)
// ============================================================================
async function processWhisper(job, localInPath, onProgress) {
    const mode = job.mode || 'burn';
    const lang = job.lang || 'auto';
    const theme = job.theme || 'random';
    const prefix = path.join(TEMP_DIR, `whisper_${job.id}`);

    let outVideoPath = null;
    let outTxtPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        const wavPath = `${prefix}_16k.wav`;
        const jsonBase = `${prefix}_out`;
        const jsonPath = `${jsonBase}.json`;

        await onProgress({ stage: '🎙️ [1/3] Extracting & normalizing 16kHz audio', percent: 18, detail: `Language: ${lang}` });
        const hasAudio = await hasAudioStream(mediaPath);
        if (!hasAudio) throw new Error('Media contains no audio stream to transcribe.');

        const audioFilters = 'loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=7500';
        await execFilePromise('ffmpeg', [
            '-y', '-i', mediaPath, '-vn', '-af', audioFilters, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath
        ], { timeout: 180000 });

        const whisperBin = process.env.WHISPER_BIN || process.env.WHISPER_CPP_BIN || '/tmp/whisper-bin/whisper-cli';
        const whisperModel = process.env.WHISPER_MODEL || process.env.WHISPER_MODEL_PATH || '/tmp/whisper-bin/ggml-small.bin';

        await onProgress({ stage: '🧠 [2/3] Running OpenAI Whisper AI on 4-Core Cloud CPU', percent: 45, detail: `Model: Whisper Small Multilingual (${lang})` });

        if (mode === 'text') {
            const { stdout } = await execFilePromise(whisperBin, [
                '-m', whisperModel, '-f', wavPath, '-l', lang, '-nt', '-t', '4', '--suppress-nst', '-nth', '0.6'
            ], { maxBuffer: 15 * 1024 * 1024, timeout: 600000 });
            outTxtPath = `${prefix}_transcription.txt`;
            const cleanOut = (stdout || '').trim();
            if (!cleanOut) throw new Error('No audible speech detected in this clip.');
            fs.writeFileSync(outTxtPath, cleanOut, 'utf8');
            return {
                outputPath: outTxtPath,
                outputFileName: `transcription_${Date.now()}.txt`,
                textPreview: cleanOut
            };
        }

        await execFilePromise(whisperBin, [
            '-m', whisperModel, '-f', wavPath, '-l', lang, '-ojf', '-of', jsonBase, '-t', '4', '--suppress-nst', '-sow', '-nth', '0.6'
        ], { maxBuffer: 15 * 1024 * 1024, timeout: 600000 });

        if (!fs.existsSync(jsonPath)) {
            throw new Error('No audible speech detected in this video.');
        }
        const parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const hasSpeech = Array.isArray(parsedJson.transcription) &&
            parsedJson.transcription.some(seg => (seg.tokens || []).some(t => t.text && !t.text.startsWith('[_') && t.text.trim()));
        if (!hasSpeech) {
            throw new Error('No audible speech detected in this video.');
        }

        outVideoPath = `${prefix}_subtitled.mp4`;
        let chosenThemeObj = null;

        await onProgress({ stage: '🎬 [3/3] Burning cinematic ASS subtitles (FFmpeg)', percent: 65, detail: `Theme: ${theme}` });

        await burnSubtitleIntoVideo(mediaPath, jsonPath, outVideoPath, {
            style: theme,
            onTheme: (t) => { chosenThemeObj = t; },
            onProgress: ({ percent, speed }) => {
                const mappedPct = 65 + Math.round((percent / 100) * 33);
                onProgress({
                    stage: '🎬 [3/3] Burning cinematic ASS subtitles (FFmpeg)',
                    percent: mappedPct,
                    speed: speed || '',
                    detail: `Theme: ${chosenThemeObj ? chosenThemeObj.label : theme} • Burning ${percent}%`
                });
            }
        });

        const origName = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
        return {
            outputPath: outVideoPath,
            outputFileName: `whisper_${chosenThemeObj?.key || theme}_${origName}.mp4`,
            meta: { theme: chosenThemeObj?.label || theme, model: 'Whisper Small (4 vCPU)' }
        };
    } finally {
        cleanupPrefixFiles(prefix, [outVideoPath, outTxtPath]);
    }
}

// ============================================================================
// 2. SONG / SONGS (LRCLIB Synced Karaoke Music Video Burner)
// ============================================================================
async function processSongBurn(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `song_${job.id}`);
    const theme = job.theme || 'random';
    let lrcItem = job.lrcItem || null;
    let targetUrl = job.url || null;
    let burnedPath = null;

    try {
        if (!lrcItem) {
            await onProgress({ stage: '🔍 [1/3] Searching LRCLIB for synced lyrics', percent: 10, detail: job.query || '' });
            lrcItem = await fetchLyricsFromLRCLIB(job.query);
            if (!lrcItem || !lrcItem.syncedLyrics) {
                throw new Error(`No synced lyrics found in LRCLIB for: "${job.query}"`);
            }
        }

        const track = lrcItem.trackName || 'Song';
        const artist = lrcItem.artistName || 'Artist';

        let videoPath = localInPath && fs.existsSync(localInPath) ? localInPath : null;
        if (!videoPath) {
            await onProgress({ stage: `📥 [1/3] Matching & downloading 1080p video (${track} - ${artist})`, percent: 25, detail: 'Searching YouTube...' });
            if (!targetUrl) {
                const best = await findBestYouTubeMatch(lrcItem);
                if (best && best.url) targetUrl = best.url;
                else {
                    const s = await yts(`${artist} ${track}`);
                    if (s.videos && s.videos.length > 0) targetUrl = s.videos[0].url;
                }
            }
            if (!targetUrl) throw new Error('Could not find matching YouTube music video.');
            videoPath = await resolveInputMedia(targetUrl, prefix, onProgress);
        }

        burnedPath = `${prefix}_burned.mp4`;
        await onProgress({ stage: `💬 [2/3] Burning LRCLIB Synced Lyrics (${track})`, percent: 55, detail: `${artist} - ${track}` });

        await burnSubtitleIntoVideo(videoPath, lrcItem.syncedLyrics, burnedPath, {
            style: theme,
            onProgress: ({ percent, speed }) => {
                const mappedPct = 55 + Math.round((percent / 100) * 43);
                onProgress({
                    stage: `💬 [2/3] Burning LRCLIB Synced Lyrics (${percent}%)`,
                    percent: mappedPct,
                    speed: speed || '',
                    detail: `${track} — ${artist}`
                });
            }
        });

        const safeName = `${track} - ${artist} (Lyrics).mp4`.replace(/[/\\?%*:|"<>]/g, '_');
        return {
            outputPath: burnedPath,
            outputFileName: safeName
        };
    } finally {
        cleanupPrefixFiles(prefix, [burnedPath]);
    }
}

// ============================================================================
// 3. MV REMIX (Custom Visual Video/Image + Song Audio + LRCLIB Lyrics)
// ============================================================================
async function processMvRemix(job, localInPath, localAudioPath, onProgress) {
    if (typeof localAudioPath === 'function') {
        onProgress = localAudioPath;
        localAudioPath = null;
    }
    const prefix = path.join(TEMP_DIR, `mv_${job.id}`);
    const theme = job.theme || 'random';
    let lrcItem = job.lrcItem || null;
    let finalFile = null;

    try {
        if (!lrcItem) {
            await onProgress({ stage: '🔍 [1/4] Fetching synced lyrics from LRCLIB', percent: 10, detail: job.songQuery });
            lrcItem = await fetchLyricsFromLRCLIB(job.songQuery);
            if (!lrcItem || !lrcItem.syncedLyrics) {
                throw new Error(`No synced lyrics found in LRCLIB for: "${job.songQuery}"`);
            }
        }

        const track = lrcItem.trackName || 'Track';
        const artist = lrcItem.artistName || 'Artist';

        await onProgress({ stage: '🎬 [1/4] Preparing visual canvas', percent: 20, detail: `${track} — ${artist}` });
        const visualPath = await resolveInputMedia(localInPath || job.visualUrl, `${prefix}_vis`, onProgress);
        const isImg = /\.(jpe?g|png|webp|bmp)$/i.test(visualPath);

        await onProgress({ stage: '🎵 [2/4] Downloading 320kbps song audio', percent: 40, detail: `${artist} - ${track}` });
        const audioFile = `${prefix}_audio.mp3`;
        let audioUrl = job.audioUrl;

        if (audioUrl === 'same' && !isImg) {
            await execFilePromise('ffmpeg', ['-y', '-i', visualPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', audioFile], { timeout: 180000 });
        } else {
            if (!audioUrl) {
                const best = await findBestYouTubeMatch(lrcItem);
                if (best && best.url) audioUrl = best.url;
                else {
                    const s = await yts(`${artist} ${track}`);
                    if (s.videos && s.videos.length > 0) audioUrl = s.videos[0].url;
                }
            }
            if (!audioUrl && !(localAudioPath && fs.existsSync(localAudioPath))) {
                throw new Error('Could not find matching audio on YouTube.');
            }
            if (localAudioPath && fs.existsSync(localAudioPath)) {
                fs.copyFileSync(localAudioPath, audioFile);
            } else {
                await runYtDlpSmart(audioUrl, audioFile, 'audio');
            }
        }

        await onProgress({ stage: '💬 [3/4] Generating responsive ASS karaoke subtitles', percent: 60, detail: `Theme: ${theme}` });
        const videoMeta = await probeVideoDimensions(visualPath);
        const renderMeta = {
            ...videoMeta,
            width: videoMeta.targetWidth || videoMeta.width,
            height: videoMeta.targetHeight || videoMeta.height
        };
        const lrcRes = lrcToAss(lrcItem.syncedLyrics, theme, renderMeta);
        const assFile = `${prefix}_mv.ass`;
        fs.writeFileSync(assFile, lrcRes.ass, 'utf8');
        const escapedAss = assFile.replace(/\\/g, '/').replace(/'/g, "\\'");

        finalFile = `${prefix}_mv_final.mp4`;
        const audioDur = (await getMediaDuration(audioFile)) || lrcItem.duration || 180;

        const scalePart = (videoMeta.targetWidth !== videoMeta.width || videoMeta.targetHeight !== videoMeta.height)
            ? `scale=${renderMeta.width}:${renderMeta.height}:flags=bicubic`
            : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        const vfArg = `${scalePart},setsar=1,ass='${escapedAss}',format=yuv420p`;

        let ffArgs = [];
        if (isImg) {
            ffArgs = ['-y', '-loop', '1', '-i', visualPath, '-i', audioFile, '-vf', vfArg, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest'];
        } else {
            ffArgs = ['-y', '-fflags', '+genpts', '-stream_loop', '-1', '-i', visualPath, '-i', audioFile, '-vf', vfArg, '-fpsmax', '30', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-pix_fmt', 'yuv420p', '-max_muxing_queue_size', '1024', '-movflags', '+faststart', '-shortest'];
        }

        await runFfmpegWithProgress({
            args: ffArgs,
            outPath: finalFile,
            inDuration: audioDur,
            onProgress: ({ percent, speed }) => {
                const mappedPct = 60 + Math.round((percent / 100) * 38);
                onProgress({
                    stage: `🔥 [4/4] Merging & burning Custom MV (${percent}%)`,
                    percent: mappedPct,
                    speed: speed || '',
                    detail: `${track} — ${artist}`
                });
            }
        });

        const safeName = `MV_${track} - ${artist}.mp4`.replace(/[/\\?%*:|"<>]/g, '_');
        return {
            outputPath: finalFile,
            outputFileName: safeName
        };
    } finally {
        cleanupPrefixFiles(prefix, [finalFile]);
    }
}

// ============================================================================
// 4. SLOW MOTION & SPED UP (Video or Audio)
// ============================================================================
async function processSpeed(job, localInPath, onProgress) {
    const isSlow = job.action === 'slow';
    const rate = isSlow
        ? Math.min(Math.max(Number(job.rate) || 0.9, 0.4), 0.98)
        : Math.min(Math.max(Number(job.rate) || Number((1 / 0.9).toFixed(4)), 1.02), 2.5);

    const prefix = path.join(TEMP_DIR, `speed_${job.id}`);
    let outPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        const isAudioOnly = Boolean(job.audioOnly) || /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(mediaPath);
        const inDuration = await getMediaDuration(mediaPath);
        const hasAudio = await hasAudioStream(mediaPath);
        const inSr = hasAudio ? await getAudioSampleRate(mediaPath) : 44100;
        const newSr = Math.round(inSr * rate);
        const exactRatio = inSr / newSr;
        const ptsFactor = exactRatio.toFixed(8);

        const ext = isAudioOnly ? 'mp3' : 'mp4';
        outPath = `${prefix}_${isSlow ? 'slowed' : 'sped'}.${ext}`;
        const label = isSlow ? `🐢 Slowing down (${rate}x)` : `⚡ Speeding up (${rate}x)`;

        let args = [];
        if (isAudioOnly) {
            if (!hasAudio) throw new Error('Audio stream not found.');
            args = ['-y', '-i', mediaPath, '-map', '0:a:0?', '-af', `asetrate=${newSr},aresample=${inSr}`, '-vn', '-b:a', '192k'];
        } else {
            args = ['-y', '-fflags', '+genpts', '-i', mediaPath];
            if (hasAudio) {
                const fc = `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,setpts=(PTS-STARTPTS)*${ptsFactor}[v];[0:a]asetrate=${newSr},aresample=${inSr}:async=1,asetpts=PTS-STARTPTS[a]`;
                args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
            } else {
                args.push('-filter_complex', `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,setpts=(PTS-STARTPTS)*${ptsFactor}[v]`, '-map', '[v]', '-an');
            }
            args.push('-fpsmax', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-max_muxing_queue_size', '1024', '-movflags', '+faststart');
        }

        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration,
            targetDurationFactor: exactRatio,
            onProgress: ({ percent, speed }) => {
                onProgress({
                    stage: `${label} — Processing (${percent}%)`,
                    percent,
                    speed: speed || '',
                    detail: `Rate: ${rate}x`
                });
            }
        });

        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'media';
        return {
            outputPath: outPath,
            outputFileName: `${isSlow ? 'slowed' : 'sped'}_${rate}x_${origBase}.${ext}`
        };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

// ============================================================================
// 5. FIX VIDEO & SMART COMPRESSION (4-vCPU Cloud Turbo)
// ============================================================================
async function processFixVideo(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `vfix_${job.id}`);
    let outPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        const inInfo = await probeVideoFull(mediaPath);
        if (!inInfo.hasVideo) {
            throw new Error('Input file does not contain a valid video stream.');
        }

        const opts = job.options || {};
        let maxShortEdge = opts.maxShortEdge !== undefined ? Number(opts.maxShortEdge) : 720;
        let crf = opts.crf !== undefined ? Number(opts.crf) : 23;
        let audioBitrate = opts.audioBitrate || '128k';
        let level = opts.level || '4.1';
        let preset = opts.fastMode ? 'superfast' : 'veryfast';
        let swsFlags = opts.fastMode ? 'bilinear' : 'lanczos';
        let targetVidKbps = null;

        outPath = `${prefix}_fixed.mp4`;

        const canRemuxDirectly = Boolean(opts.remuxOnly) &&
            inInfo.vCodec === 'h264' &&
            inInfo.pixFmt === 'yuv420p';

        let args = [];
        if (canRemuxDirectly) {
            args = ['-y', '-fflags', '+genpts', '-err_detect', 'ignore_err', '-i', mediaPath, '-map', '0:v:0'];
            if (inInfo.hasAudio) {
                if (inInfo.aCodec === 'aac' && inInfo.aChannels <= 2) {
                    args.push('-map', '0:a:0?', '-c:a', 'copy');
                } else {
                    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2', '-ar', '44100');
                }
            } else {
                args.push('-an');
            }
            args.push('-sn', '-dn', '-c:v', 'copy', '-max_muxing_queue_size', '1024', '-movflags', '+faststart');
        } else {
            if (opts.targetMB && inInfo.duration > 0) {
                const totalKbps = Math.floor((Number(opts.targetMB) * 8192 * 0.94) / inInfo.duration);
                const audKbps = inInfo.hasAudio ? (totalKbps < 450 ? 64 : (totalKbps < 900 ? 96 : 128)) : 0;
                audioBitrate = `${audKbps || 96}k`;
                targetVidKbps = Math.max(120, totalKbps - audKbps);

                if (!opts.explicitRes) {
                    if (targetVidKbps < 450) {
                        maxShortEdge = 480;
                        level = '3.1';
                    } else if (targetVidKbps < 1200) {
                        maxShortEdge = 720;
                        level = '4.1';
                    } else {
                        maxShortEdge = 1080;
                        level = '4.2';
                    }
                }
            }

            const scaleFilter = maxShortEdge > 0
                ? `scale='if(gt(iw,ih),-2,if(gt(iw,${maxShortEdge}),${maxShortEdge},trunc(iw/2)*2))':'if(gt(iw,ih),if(gt(ih,${maxShortEdge}),${maxShortEdge},trunc(ih/2)*2),-2)':flags=${swsFlags},setsar=1,format=yuv420p`
                : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p';

            args = ['-y', '-fflags', '+genpts', '-err_detect', 'ignore_err', '-i', mediaPath, '-map', '0:v:0'];
            if (inInfo.hasAudio) args.push('-map', '0:a:0?');
            args.push(
                '-sn', '-dn',
                '-vf', scaleFilter,
                '-fpsmax', '60',
                '-c:v', 'libx264',
                '-preset', preset,
                '-profile:v', 'high',
                '-level:v', level,
                '-pix_fmt', 'yuv420p'
            );

            if (targetVidKbps) {
                args.push('-b:v', `${targetVidKbps}k`, '-maxrate', `${Math.round(targetVidKbps * 1.25)}k`, '-bufsize', `${Math.round(targetVidKbps * 2)}k`);
            } else {
                args.push('-crf', String(crf));
                if (inInfo.vCodec === 'h264' && opts.presetKey !== 'hd' && opts.presetKey !== 'orig' && inInfo.duration > 0) {
                    const inTotalKbps = Math.round((inInfo.sizeBytes * 8) / (inInfo.duration * 1000));
                    const capKbps = Math.max(300, Math.min(2800, Math.round(inTotalKbps * 0.72)));
                    args.push('-maxrate', `${capKbps}k`, '-bufsize', `${capKbps * 2}k`);
                }
            }

            if (inInfo.hasAudio) {
                if (inInfo.aCodec === 'aac' && inInfo.aChannels > 0 && inInfo.aChannels <= 2 && opts.presetKey !== 'low') {
                    args.push('-c:a', 'copy');
                } else {
                    args.push('-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2', '-ar', '44100');
                }
            } else {
                args.push('-an');
            }

            args.push('-max_muxing_queue_size', '1024', '-movflags', '+faststart');
        }

        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration: inInfo.duration,
            onProgress: ({ percent, speed }) => {
                onProgress({
                    stage: canRemuxDirectly ? `⚡ Remuxing MP4 container (${percent}%)` : `🛠️ Repairing & compressing on 4-vCPU Cloud (${percent}%)`,
                    percent,
                    speed: speed || '',
                    detail: opts.label || 'Cloud Smart Compression'
                });
            }
        });

        const outInfo = await probeVideoFull(outPath);
        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
        return {
            outputPath: outPath,
            outputFileName: `fixed_${origBase}.mp4`,
            meta: {
                inCodec: inInfo.vCodec,
                outCodec: outInfo.vCodec,
                inRes: (inInfo.width && inInfo.height) ? `${inInfo.width}×${inInfo.height}` : 'unknown',
                outRes: (outInfo.width && outInfo.height) ? `${outInfo.width}×${outInfo.height}` : 'unknown',
                inSize: inInfo.sizeBytes,
                outSize: outInfo.sizeBytes
            }
        };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

// ============================================================================
// 6. CUT / ROTATE / MP3 / THEME / AUDIO MERGE
// ============================================================================
async function processCut(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `cut_${job.id}`);
    let outPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        const isAudio = /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(mediaPath);
        const ext = isAudio ? 'mp3' : 'mp4';
        outPath = `${prefix}_cut.${ext}`;

        const start = job.start || 0;
        const end = job.end || 'end';
        const args = ['-y', '-ss', String(start)];
        if (end !== 'end' && Number(end) > 0) args.push('-to', String(end));
        args.push('-fflags', '+genpts', '-i', mediaPath);

        if (isAudio) {
            args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k');
        } else {
            const hasAudio = await hasAudioStream(mediaPath);
            args.push('-map', '0:v:0');
            if (hasAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
            else args.push('-an');
            args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-max_muxing_queue_size', '1024', '-movflags', '+faststart');
        }

        const totalDur = await getMediaDuration(mediaPath);
        const dur = (end !== 'end' && Number(end) > Number(start)) ? (Number(end) - Number(start)) : (totalDur ? Math.max(1, totalDur - Number(start)) : null);
        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration: dur,
            onProgress: ({ percent, speed }) => {
                onProgress({ stage: `✂️ Trimming clip (${start}s -> ${end})`, percent, speed: speed || '' });
            }
        });

        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'clip';
        return { outputPath: outPath, outputFileName: `cut_${origBase}.${ext}` };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

async function processRotate(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `rot_${job.id}`);
    let outPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        const raw = String(job.angle || '90').toLowerCase();
        let filter = 'transpose=1';
        if (['180', '-180', 'flip'].includes(raw)) filter = 'transpose=1,transpose=1';
        else if (['-90', '270', 'left', 'ccw'].includes(raw)) filter = 'transpose=2';
        else if (['hflip', 'mirror'].includes(raw)) filter = 'hflip';
        else if (['vflip'].includes(raw)) filter = 'vflip';

        outPath = `${prefix}_rotated.mp4`;
        const inDuration = await getMediaDuration(mediaPath);
        const hasAudio = await hasAudioStream(mediaPath);
        const args = [
            '-y', '-fflags', '+genpts', '-i', mediaPath,
            '-vf', `${filter},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p`,
            '-map', '0:v:0'
        ];
        if (hasAudio) {
            args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
        } else {
            args.push('-an');
        }
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-max_muxing_queue_size', '1024', '-movflags', '+faststart');

        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration,
            onProgress: ({ percent, speed }) => {
                onProgress({ stage: `🔄 Rotating media (${raw}) — ${percent}%`, percent, speed: speed || '' });
            }
        });

        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
        return { outputPath: outPath, outputFileName: `rotated_${origBase}.mp4` };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

async function processMp3(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `mp3_${job.id}`);
    let outPath = null;

    try {
        const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
        outPath = `${prefix}_audio.mp3`;
        const inDuration = await getMediaDuration(mediaPath);
        const hasAudio = await hasAudioStream(mediaPath);
        if (!hasAudio) throw new Error('Media contains no audio stream.');

        const args = ['-y', '-i', mediaPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k'];
        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration,
            onProgress: ({ percent, speed }) => {
                onProgress({ stage: `🎧 Extracting 320kbps MP3 (${percent}%)`, percent, speed: speed || '' });
            }
        });

        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'audio';
        return { outputPath: outPath, outputFileName: `${origBase}.mp3` };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

async function processTheme(job, onProgress) {
    await onProgress({ stage: '🎨 Rendering Subtitle Themes Showcase', percent: 50, detail: job.theme || 'all' });
    const res = await renderThemePreview(job.theme || 'all', job.text || '');
    if (!res || !res.imagePath) throw new Error('Failed to generate theme preview image.');
    return {
        outputPath: res.imagePath,
        outputFileName: `themes_preview_${job.theme || 'all'}.jpg`
    };
}

async function processAudioMerge(job, localInPath, localAudioPath, onProgress) {
    const mode = job.mode === 'mix' ? 'mix' : 'replace';
    const prefix = path.join(TEMP_DIR, `amerge_${job.id}`);
    let outPath = null;

    try {
        const vidPath = await resolveInputMedia(localInPath || job.url, `${prefix}_v`, onProgress);
        const audPath = await resolveInputMedia(localAudioPath || job.audioUrl, `${prefix}_a`, onProgress);
        outPath = `${prefix}_merged.mp4`;
        const inInfo = await probeVideoFull(vidPath);
        const canCopyVideo = inInfo.vCodec === 'h264' && inInfo.pixFmt === 'yuv420p';

        let args = [];
        if (mode === 'mix') {
            args = ['-y', '-i', vidPath, '-stream_loop', '-1', '-i', audPath, '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '0:v:0', '-map', '[a]'];
        } else {
            args = ['-y', '-i', vidPath, '-stream_loop', '-1', '-i', audPath, '-map', '0:v:0', '-map', '1:a:0'];
        }

        if (canCopyVideo) {
            args.push('-c:v', 'copy');
        } else {
            args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p');
        }
        args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-shortest', '-max_muxing_queue_size', '1024', '-movflags', '+faststart');

        await runFfmpegWithProgress({
            args,
            outPath,
            inDuration: inInfo.duration,
            onProgress: ({ percent, speed }) => {
                onProgress({ stage: `🎚️ ${mode === 'mix' ? 'Mixing' : 'Replacing'} Video Audio (${percent}%)`, percent, speed: speed || '' });
            }
        });

        const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
        return { outputPath: outPath, outputFileName: `${mode}audio_${origBase}.mp4` };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

async function processSpeedtest(job, onProgress) {
    const prefix = path.join(TEMP_DIR, `speedtest_${job.id}`);
    const outPath = `${prefix}_result.json`;
    const upTmp = `${prefix}_up.bin`;
    const upMultiTmp = `${prefix}_up10.bin`;

    try {
        await onProgress({ stage: '🌐 [1/4] Checking datacenter region & latency...', percent: 15 });
        let geo = {};
        try {
            const g = await axios.get('https://ipinfo.io/json', { timeout: 8000 });
            geo = { city: g.data?.city, region: g.data?.region, country: g.data?.country, org: g.data?.org };
        } catch (_) {}

        let connS = 0, ttfbS = 0;
        try {
            const { stdout: pingOut } = await execFilePromise('curl', [
                '-s', '-o', '/dev/null', '--max-time', '10',
                '-w', '%{time_connect} %{time_starttransfer}',
                'https://ash-speed.hetzner.com/100MB.bin', '--range', '0-0'
            ], { timeout: 15000 });
            [connS, ttfbS] = pingOut.trim().split(/\s+/).map(Number);
        } catch (_) {}

        await onProgress({ stage: '📥 [2/4] Testing single & multi-stream download (500 MB)...', percent: 35 });
        const dlUrl = 'https://ash-speed.hetzner.com/100MB.bin';
        const { stdout: dl1Out } = await execFilePromise('curl', [
            '-s', '-o', '/dev/null', '--max-time', '45',
            '-w', '%{http_code} %{size_download} %{time_total} %{speed_download}',
            dlUrl
        ], { timeout: 50000 });
        const [dl1Http, dl1Bytes, dl1Time, dl1Bps] = dl1Out.trim().split(/\s+/).map(Number);

        const tStartMultiDl = Date.now();
        const multiDlResults = await Promise.all([0, 1, 2, 3].map(() =>
            execFilePromise('curl', ['-s', '-o', '/dev/null', '--max-time', '45', '-w', '%{size_download}', dlUrl], { timeout: 50000 })
        ));
        const multiDlSec = Math.max(0.05, (Date.now() - tStartMultiDl) / 1000);
        const multiDlTotalBytes = multiDlResults.reduce((s, r) => s + (parseInt(r.stdout.trim(), 10) || 0), 0);
        const multiDlBps = multiDlTotalBytes / multiDlSec;

        await onProgress({ stage: '📤 [3/4] Testing single & multi-stream upload...', percent: 70 });
        let ul1Bytes = 0, ul1Time = 0, ul1Bps = 0, multiUlBps = 0, multiUlSec = 0, uploadNote = 'ok';
        try {
            fs.writeFileSync(upTmp, Buffer.alloc(25 * 1024 * 1024, 0x41));
            const { stdout: ul1Out } = await execFilePromise('curl', [
                '-s', '-o', '/dev/null', '--max-time', '25', '-X', 'POST',
                '--data-binary', `@${upTmp}`,
                '-w', '%{size_upload} %{time_total} %{speed_upload}',
                'https://speed.cloudflare.com/__up'
            ], { timeout: 30000 });
            [ul1Bytes, ul1Time, ul1Bps] = ul1Out.trim().split(/\s+/).map(Number);

            fs.writeFileSync(upMultiTmp, Buffer.alloc(10 * 1024 * 1024, 0x42));
            const tStartMultiUl = Date.now();
            await Promise.all([0, 1, 2, 3].map(() =>
                execFilePromise('curl', ['-s', '-o', '/dev/null', '--max-time', '25', '-X', 'POST', '--data-binary', `@${upMultiTmp}`, 'https://speed.cloudflare.com/__up'], { timeout: 30000 })
            ));
            multiUlSec = Math.max(0.05, (Date.now() - tStartMultiUl) / 1000);
            multiUlBps = (4 * 10 * 1024 * 1024) / multiUlSec;
        } catch (upErr) {
            uploadNote = 'partial_or_throttled: ' + upErr.message;
        }

        const toMbps = (bps) => Number((((bps || 0) * 8) / 1e6).toFixed(2));
        const toMBs = (bps) => Number(((bps || 0) / (1024 * 1024)).toFixed(2));

        const report = {
            geo,
            latency: {
                tcpConnectMs: Number(((connS || 0) * 1000).toFixed(1)),
                ttfbMs: Number(((ttfbS || 0) * 1000).toFixed(1))
            },
            download: {
                endpoint: 'ash-speed.hetzner.com/100MB.bin',
                httpCode: dl1Http,
                singleBytes: dl1Bytes,
                singleSec: Number((dl1Time || 0).toFixed(2)),
                singleMbps: toMbps(dl1Bps),
                singleMBs: toMBs(dl1Bps),
                multiTotalBytes: multiDlTotalBytes,
                multiMbps: toMbps(multiDlBps),
                multiMBs: toMBs(multiDlBps),
                multiSec: Number(multiDlSec.toFixed(2))
            },
            upload: {
                note: uploadNote,
                singleBytes: ul1Bytes,
                singleSec: Number((ul1Time || 0).toFixed(2)),
                singleMbps: toMbps(ul1Bps),
                singleMBs: toMBs(ul1Bps),
                multiMbps: toMbps(multiUlBps),
                multiMBs: toMBs(multiUlBps),
                multiSec: Number(multiUlSec.toFixed(2))
            }
        };

        fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
        return {
            outputPath: outPath,
            outputFileName: 'cloud_speedtest.json',
            textPreview: JSON.stringify(report),
            meta: report
        };
    } finally {
        cleanupPrefixFiles(prefix, [outPath]);
    }
}

module.exports = {
    processWhisper,
    processSongBurn,
    processMvRemix,
    processSpeed,
    processFixVideo,
    processCut,
    processRotate,
    processMp3,
    processTheme,
    processAudioMerge,
    processSpeedtest
};
