const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const axios = require('axios');
const yts = require('yt-search');
const execPromise = util.promisify(exec);

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

function getCookiesArg() {
    const cookiesPath = path.join( process.cwd(), 'cookies.txt');
    if (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 20) {
        return `--cookies "${cookiesPath}"`;
    }
    return '';
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
        proc.on('error', () => resolve(true));
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

function runFfmpegWithProgress({ args, outPath, inDuration, targetDurationFactor = 1.0, onProgress }) {
    return new Promise((resolve, reject) => {
        const targetDuration = inDuration && inDuration > 0 ? (inDuration * targetDurationFactor) : null;
        const ffArgs = [...args, '-threads', '0', '-progress', 'pipe:1', '-nostats', outPath];
        const proc = spawn('ffmpeg', ffArgs);

        let stdoutBuf = '';
        proc.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop();
            let outTimeUs = null;
            let speed = null;
            for (const line of lines) {
                const [k, v] = line.split('=');
                if (!k || !v) continue;
                if (k.trim() === 'out_time_us') outTimeUs = parseInt(v.trim(), 10);
                else if (k.trim() === 'speed') speed = v.trim();
            }
            if (typeof onProgress === 'function' && outTimeUs !== null && !isNaN(outTimeUs)) {
                const currentSec = outTimeUs / 1000000;
                let percent = 50;
                if (targetDuration && targetDuration > 0) {
                    percent = Math.min(99, Math.max(1, Math.round((currentSec / targetDuration) * 100)));
                }
                onProgress({ percent, currentSec, targetDuration, speed });
            }
        });

        proc.on('close', code => {
            if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

async function resolveInputMedia(inputSpec, outPrefix, onProgress) {
    if (inputSpec && fs.existsSync(inputSpec)) {
        return inputSpec;
    }
    if (typeof inputSpec === 'string' && /^https?:\/\//i.test(inputSpec)) {
        await onProgress({ stage: '📥 Downloading Media (10Gbps Cloud)', percent: 15, detail: inputSpec });
        const cookiesArg = getCookiesArg();
        const isImg = /\.(jpe?g|png|webp|bmp)($|\?)/i.test(inputSpec);
        if (isImg) {
            const imgPath = `${outPrefix}_in.jpg`;
            const res = await axios.get(inputSpec, { responseType: 'arraybuffer', timeout: 30000 });
            fs.writeFileSync(imgPath, Buffer.from(res.data));
            return imgPath;
        }
        const outFile = `${outPrefix}_dl.mp4`;
        const cmd = `yt-dlp ${cookiesArg} --no-playlist -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" --format-sort "res:1080,res,vcodec:avc,size,tbr" --merge-output-format mp4 -o "${outFile}" "${inputSpec}"`;
        await execPromise(cmd, { timeout: 300000 });
        if (fs.existsSync(outFile)) return outFile;
        throw new Error('Failed to download media from URL.');
    }
    throw new Error('Invalid or missing media input.');
}

// ============================================================================
// 1. WHISPER V (Burn Subtitles) & WHISPER TEXT (Transcribe)
// ============================================================================
async function processWhisper(job, localInPath, onProgress) {
    const mode = job.mode || 'burn'; // 'burn' or 'text'
    const lang = job.lang || 'auto';
    const theme = job.theme || 'random';
    const prefix = path.join(TEMP_DIR, `whisper_${job.id}`);

    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const wavPath = `${prefix}_16k.wav`;
    const jsonBase = `${prefix}_out`;
    const jsonPath = `${jsonBase}.json`;

    await onProgress({ stage: '🎙️ [1/3] Extracting & normalizing 16kHz audio', percent: 18, detail: `Language: ${lang}` });
    const hasAudio = await hasAudioStream(mediaPath);
    if (!hasAudio) throw new Error('Media contains no audio stream to transcribe.');

    const audioFilters = 'loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=80,lowpass=f=7500';
    await execPromise(`ffmpeg -y -i "${mediaPath}" -vn -af "${audioFilters}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`);

    const whisperBin = process.env.WHISPER_BIN || '/tmp/whisper-bin/whisper-cli';
    const whisperModel = process.env.WHISPER_MODEL || '/tmp/whisper-bin/ggml-small.bin';

    await onProgress({ stage: '🧠 [2/3] Running OpenAI Whisper AI on 4-Core Cloud CPU', percent: 45, detail: `Model: Whisper Small Multilingual (${lang})` });

    if (mode === 'text') {
        const cmd = `"${whisperBin}" -m "${whisperModel}" -f "${wavPath}" -l ${lang} -nt -t 4 --suppress-nst -nth 0.6`;
        const { stdout } = await execPromise(cmd, { maxBuffer: 15 * 1024 * 1024 });
        const outTxtPath = `${prefix}_transcription.txt`;
        fs.writeFileSync(outTxtPath, (stdout || '').trim(), 'utf8');
        return {
            outputPath: outTxtPath,
            outputFileName: `transcription_${Date.now()}.txt`,
            textPreview: (stdout || '').trim()
        };
    }

    const cmd = `"${whisperBin}" -m "${whisperModel}" -f "${wavPath}" -l ${lang} -ojf -of "${jsonBase}" -t 4 --suppress-nst -sow -nth 0.6`;
    await execPromise(cmd, { maxBuffer: 15 * 1024 * 1024 });

    if (!fs.existsSync(jsonPath)) {
        throw new Error('No audible speech detected in this video.');
    }

    const outVideoPath = `${prefix}_subtitled.mp4`;
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
        outputFileName: `whisper_${ chosenThemeObj?.key || theme }_${origName}.mp4`
    };
}

// ============================================================================
// 2. SONG / SONGS (LRCLIB Synced Karaoke Music Video Burner)
// ============================================================================
async function processSongBurn(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `song_${job.id}`);
    const theme = job.theme || 'random';
    let lrcItem = job.lrcItem || null;
    let targetUrl = job.url || null;

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

    const burnedPath = `${prefix}_burned.mp4`;
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
}

// ============================================================================
// 3. MV REMIX (Custom Visual Video/Image + Song Audio + LRCLIB Lyrics)
// ============================================================================
async function processMvRemix(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `mv_${job.id}`);
    const theme = job.theme || 'random';
    let lrcItem = job.lrcItem || null;

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
        await execPromise(`ffmpeg -y -i "${visualPath}" -vn -c:a libmp3lame -b:a 320k "${audioFile}"`);
    } else {
        if (!audioUrl) {
            const best = await findBestYouTubeMatch(lrcItem);
            if (best && best.url) audioUrl = best.url;
            else {
                const s = await yts(`${artist} ${track}`);
                if (s.videos && s.videos.length > 0) audioUrl = s.videos[0].url;
            }
        }
        if (!audioUrl) throw new Error('Could not find matching audio on YouTube.');
        const cookiesArg = getCookiesArg();
        await execPromise(`yt-dlp ${cookiesArg} --no-playlist -x --audio-format mp3 --audio-quality 320k -o "${audioFile}" "${audioUrl}"`, { timeout: 300000 });
    }

    await onProgress({ stage: '💬 [3/4] Generating responsive ASS karaoke subtitles', percent: 60, detail: `Theme: ${theme}` });
    const videoMeta = await probeVideoDimensions(visualPath);
    const lrcRes = lrcToAss(lrcItem.syncedLyrics, theme, videoMeta);
    const assFile = `${prefix}_mv.ass`;
    fs.writeFileSync(assFile, lrcRes.ass, 'utf8');
    const escapedAss = assFile.replace(/\\/g, '/').replace(/'/g, "\\'");

    const finalFile = `${prefix}_mv_final.mp4`;
    const audioDur = (await getMediaDuration(audioFile)) || lrcItem.duration || 180;

    let ffArgs = [];
    if (isImg) {
        ffArgs = ['-y', '-loop', '1', '-i', visualPath, '-i', audioFile, '-vf', `scale='trunc(iw/2)*2:trunc(ih/2)*2',ass='${escapedAss}'`, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-shortest'];
    } else {
        ffArgs = ['-y', '-stream_loop', '-1', '-i', visualPath, '-i', audioFile, '-vf', `ass='${escapedAss}'`, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
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
    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const isAudioOnly = Boolean(job.audioOnly) || /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(mediaPath);
    const inDuration = await getMediaDuration(mediaPath);
    const hasAudio = await hasAudioStream(mediaPath);
    const inSr = hasAudio ? await getAudioSampleRate(mediaPath) : 44100;
    const newSr = Math.round(inSr * rate);
    const exactRatio = inSr / newSr;
    const ptsFactor = exactRatio.toFixed(8);

    const ext = isAudioOnly ? 'mp3' : 'mp4';
    const outPath = `${prefix}_${isSlow ? 'slowed' : 'sped'}.${ext}`;
    const label = isSlow ? `🐢 Slowing down (${rate}x)` : `⚡ Speeding up (${rate}x)`;

    let args = [];
    if (isAudioOnly) {
        args = ['-y', '-i', mediaPath, '-map', '0:a:0?', '-af', `asetrate=${newSr},aresample=${inSr}`, '-vn', '-b:a', '192k'];
    } else {
        args = ['-y', '-i', mediaPath];
        if (hasAudio) {
            const fc = `[0:v]setpts=(PTS-STARTPTS)*${ptsFactor}[v];[0:a]asetrate=${newSr},aresample=${inSr}:async=1,asetpts=PTS-STARTPTS[a]`;
            args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
        } else {
            args.push('-filter_complex', `[0:v]setpts=(PTS-STARTPTS)*${ptsFactor}[v]`, '-map', '[v]');
        }
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
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
}

// ============================================================================
// 5. CUT / ROTATE / FPS60 / MP3 / THEME
// ============================================================================
async function processCut(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `cut_${job.id}`);
    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const isAudio = /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(mediaPath);
    const ext = isAudio ? 'mp3' : 'mp4';
    const outPath = `${prefix}_cut.${ext}`;

    const start = job.start || 0;
    const end = job.end || 'end';
    const args = ['-y', '-ss', String(start)];
    if (end !== 'end' && Number(end) > 0) args.push('-to', String(end));
    args.push('-i', mediaPath);

    if (isAudio) {
        args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '320k');
    } else {
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
    }

    const dur = (end !== 'end' && Number(end) > Number(start)) ? (Number(end) - Number(start)) : await getMediaDuration(mediaPath);
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
}

async function processFps(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `fps_${job.id}`);
    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const targetFps = Math.min(Math.max(parseInt(job.fps || 60, 10), 15), 60);
    const outPath = `${prefix}_fps${targetFps}.mp4`;
    const inDuration = await getMediaDuration(mediaPath);

    const args = ['-y', '-i', mediaPath, '-vf', `fps=${targetFps}`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];
    await runFfmpegWithProgress({
        args,
        outPath,
        inDuration,
        onProgress: ({ percent, speed }) => {
            onProgress({ stage: `🎞️ Converting to ${targetFps} FPS (${percent}%)`, percent, speed: speed || '' });
        }
    });

    const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
    return { outputPath: outPath, outputFileName: `fps${targetFps}_${origBase}.mp4` };
}

async function processRotate(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `rot_${job.id}`);
    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const raw = String(job.angle || '90').toLowerCase();
    let filter = 'transpose=1';
    if (['180', '-180', 'flip'].includes(raw)) filter = 'transpose=1,transpose=1';
    else if (['-90', '270', 'left', 'ccw'].includes(raw)) filter = 'transpose=2';
    else if (['hflip', 'mirror'].includes(raw)) filter = 'hflip';
    else if (['vflip'].includes(raw)) filter = 'vflip';

    const outPath = `${prefix}_rotated.mp4`;
    const inDuration = await getMediaDuration(mediaPath);
    const args = ['-y', '-i', mediaPath, '-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'];

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
}

async function processMp3(job, localInPath, onProgress) {
    const prefix = path.join(TEMP_DIR, `mp3_${job.id}`);
    const mediaPath = await resolveInputMedia(localInPath || job.url, prefix, onProgress);
    const outPath = `${prefix}_audio.mp3`;
    const inDuration = await getMediaDuration(mediaPath);

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
    const vidPath = await resolveInputMedia(localInPath || job.url, `${prefix}_v`, onProgress);
    const audPath = await resolveInputMedia(localAudioPath || job.audioUrl, `${prefix}_a`, onProgress);
    const outPath = `${prefix}_merged.mp4`;
    const inDuration = await getMediaDuration(vidPath);

    let args = [];
    if (mode === 'mix') {
        args = ['-y', '-i', vidPath, '-stream_loop', '-1', '-i', audPath, '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]', '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'];
    } else {
        args = ['-y', '-i', vidPath, '-stream_loop', '-1', '-i', audPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'];
    }

    await runFfmpegWithProgress({
        args,
        outPath,
        inDuration,
        onProgress: ({ percent, speed }) => {
            onProgress({ stage: `🎚️ ${mode === 'mix' ? 'Mixing' : 'Replacing'} Video Audio (${percent}%)`, percent, speed: speed || '' });
        }
    });

    const origBase = job.fileName ? path.basename(job.fileName, path.extname(job.fileName)) : 'video';
    return { outputPath: outPath, outputFileName: `${mode}audio_${origBase}.mp4` };
}

module.exports = {
    processWhisper,
    processSongBurn,
    processMvRemix,
    processSpeed,
    processCut,
    processFps,
    processRotate,
    processMp3,
    processTheme,
    processAudioMerge
};
