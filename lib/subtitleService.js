const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

// Professional High-Contrast Visual Themes (Identical to Ares-MD)
const THEMES = {
    gold: {
        name: 'Gold',
        label: 'Golden Yellow',
        primary: '&H0000D7FF&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    },
    emerald: {
        name: 'Emerald',
        label: 'Emerald Green',
        primary: '&H004FE82E&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    },
    crimson: {
        name: 'Crimson',
        label: 'Crimson Red',
        primary: '&H003535FF&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    },
    cyan: {
        name: 'Cyan',
        label: 'Electric Cyan',
        primary: '&H00FFF500&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    },
    amber: {
        name: 'Amber',
        label: 'Neon Amber',
        primary: '&H00189BFF&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    },
    box: {
        name: 'ModernBox',
        label: 'Modern Dark Box',
        primary: '&H00FFFFFF&',
        outline: '&H00000000&',
        back: '&HB8121212&',
        borderStyle: 3
    },
    white: {
        name: 'ClassicWhite',
        label: 'High-Contrast White',
        primary: '&H00FFFFFF&',
        outline: '&H00000000&',
        back: '&H00000000&',
        borderStyle: 1
    }
};

const THEME_KEYS = ['gold', 'emerald', 'crimson', 'cyan', 'amber', 'box', 'white'];

function resolveTheme(requestedPreset) {
    if (!requestedPreset || requestedPreset === 'random' || requestedPreset === 'dynamic_word') {
        const randomKey = THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
        return { key: randomKey, ...THEMES[randomKey] };
    }

    const clean = String(requestedPreset).toLowerCase().trim();
    if (clean.includes('red') || clean.includes('crimson')) return { key: 'crimson', ...THEMES.crimson };
    if (clean.includes('green') || clean.includes('emerald')) return { key: 'emerald', ...THEMES.emerald };
    if (clean.includes('yellow') || clean.includes('gold')) return { key: 'gold', ...THEMES.gold };
    if (clean.includes('cyan') || clean.includes('blue')) return { key: 'cyan', ...THEMES.cyan };
    if (clean.includes('amber') || clean.includes('orange')) return { key: 'amber', ...THEMES.amber };
    if (clean.includes('box')) return { key: 'box', ...THEMES.box };
    if (clean.includes('white') || clean.includes('classic')) return { key: 'white', ...THEMES.white };

    const randomKey = THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
    return { key: randomKey, ...THEMES[randomKey] };
}

function formatAssTime(t) {
    if (t < 0 || isNaN(t)) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor(((t % 1) * 100));
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function parseSrtTimestamp(t) {
    if (!t || typeof t !== 'string') return 0;
    const parts = t.trim().split(':');
    if (parts.length < 3) return 0;
    const secParts = parts[2].replace(',', '.').split('.');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseInt(secParts[0], 10) || 0;
    const ms = parseInt(secParts[1] || '0', 10);
    const fraction = (secParts[1] && secParts[1].length === 2) ? (ms / 100) : (ms / 1000);
    return h * 3600 + m * 60 + s + fraction;
}

async function probeVideoDimensions(videoPath) {
    try {
        const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,r_frame_rate,tags:format=duration -of json "${videoPath}"`;
        const { stdout } = await execPromise(cmd, { timeout: 15000 });
        const data = JSON.parse(stdout || '{}');
        const stream = (data.streams && data.streams[0]) || {};
        let width = parseInt(stream.width, 10) || 1280;
        let height = parseInt(stream.height, 10) || 720;
        let duration = parseFloat(data.format?.duration || stream.duration) || 0;

        let rotation = 0;
        if (stream.tags && stream.tags.rotate) {
            rotation = parseInt(stream.tags.rotate, 10) || 0;
        }
        if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
            const tmp = width;
            width = height;
            height = tmp;
        }

        const isVertical = height > width;
        const aspectRatio = width / height;

        let fps = 30;
        if (stream.r_frame_rate) {
            const parts = stream.r_frame_rate.split('/');
            if (parts.length === 2 && parseInt(parts[1], 10) > 0) {
                fps = Math.round(parseInt(parts[0], 10) / parseInt(parts[1], 10));
            } else {
                fps = Math.round(parseFloat(stream.r_frame_rate)) || 30;
            }
        }

        // On our 4-vCPU / 16GB RAM Cloud Server, we preserve up to 1080p Full HD!
        let targetWidth = width;
        let targetHeight = height;

        if (isVertical) {
            if (width > 1080) {
                targetWidth = 1080;
                targetHeight = Math.round(1080 / aspectRatio);
            }
        } else {
            if (height > 1080) {
                targetHeight = 1080;
                targetWidth = Math.round(1080 * aspectRatio);
            }
        }

        targetWidth = targetWidth - (targetWidth % 2);
        targetHeight = targetHeight - (targetHeight % 2);

        return { width, height, targetWidth, targetHeight, duration, fps, isVertical, aspectRatio };
    } catch (err) {
        return { width: 1280, height: 720, targetWidth: 1280, targetHeight: 720, duration: 0, fps: 30, isVertical: false, aspectRatio: 16 / 9 };
    }
}

function buildAssHeader(videoMeta = null) {
    const meta = videoMeta || { width: 1280, height: 720, isVertical: false };
    const w = meta.width || 1280;
    const h = meta.height || 720;
    const isVert = Boolean(meta.isVertical);

    let fontSize;
    let marginV;
    let marginSide = Math.round(w * 0.07);

    if (isVert) {
        fontSize = Math.max(34, Math.round(w * 0.054));
        marginV = Math.max(80, Math.round(h * 0.19));
    } else {
        fontSize = Math.max(28, Math.round(h * 0.060));
        marginV = Math.max(38, Math.round(h * 0.09));
    }

    const outline = Math.max(2, Math.round(fontSize * 0.10));
    const shadow = Math.max(1, Math.round(fontSize * 0.05));

    let stylesAss = '';
    for (const key of THEME_KEYS) {
        const t = THEMES[key];
        const out = (t.borderStyle === 3) ? Math.max(2, Math.round(outline * 1.3)) : outline;
        const shd = (t.borderStyle === 3) ? 0 : shadow;
        stylesAss += `Style: ${t.name},DejaVu Sans,${fontSize},${t.primary},${t.primary},${t.outline},${t.back},-1,0,0,0,100,100,0,0,${t.borderStyle},${out},${shd},2,${marginSide},${marginSide},${marginV},1\n`;
    }

    return `[Script Info]
Title: Ares-MD Professional Subtitle Engine
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.601
PlayResX: ${w}
PlayResY: ${h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${stylesAss}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function cleanYouTubeRollingCaptions(srtContent) {
    if (!srtContent || typeof srtContent !== 'string') return '';
    const lines = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const cues = [];
    let curCue = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);

        if (timeMatch) {
            if (curCue && curCue.textLines.length > 0) cues.push(curCue);
            curCue = {
                startStr: timeMatch[1].replace('.', ','),
                endStr: timeMatch[2].replace('.', ','),
                startSec: parseSrtTimestamp(timeMatch[1]),
                endSec: parseSrtTimestamp(timeMatch[2]),
                textLines: []
            };
        } else if (curCue) {
            if (/^\d+$/.test(line) && i + 1 < lines.length && lines[i + 1].includes('-->')) continue;
            if (line.length > 0) curCue.textLines.push(line);
        }
    }
    if (curCue && curCue.textLines.length > 0) cues.push(curCue);

    const filtered = cues.filter(cue => (cue.endSec - cue.startSec) >= 0.25);
    const cleaned = [];

    for (const cue of filtered) {
        let cueText = cue.textLines[cue.textLines.length - 1] || '';
        cueText = cueText.trim();
        if (!cueText) continue;

        if (cleaned.length > 0 && cleaned[cleaned.length - 1].text.toLowerCase() === cueText.toLowerCase()) {
            cleaned[cleaned.length - 1].endStr = cue.endStr;
            cleaned[cleaned.length - 1].endSec = cue.endSec;
        } else {
            cleaned.push({
                startStr: cue.startStr,
                endStr: cue.endStr,
                startSec: cue.startSec,
                endSec: cue.endSec,
                text: cueText
            });
        }
    }

    let result = '';
    cleaned.forEach((c, idx) => {
        result += (idx + 1) + '\n' + c.startStr + ' --> ' + c.endStr + '\n' + c.text + '\n\n';
    });
    return result;
}

function parseSrt(srtContent) {
    if (!srtContent) return [];
    const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);
    const cues = [];

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;

        let timeLine = lines[0].includes('-->') ? lines[0] : (lines[1].includes('-->') ? lines[1] : null);
        if (!timeLine) continue;

        const timeMatch = timeLine.match(/^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
        if (!timeMatch) continue;

        const startSec = parseSrtTimestamp(timeMatch[1]);
        const endSec = parseSrtTimestamp(timeMatch[2]);
        const textStartIndex = lines.indexOf(timeLine) + 1;
        const text = lines.slice(textStartIndex).join(' ').trim();

        if (text && endSec > startSec) cues.push({ startSec, endSec, text });
    }
    return cues;
}

function formatUnitWordsWithWrap(words, maxLineChars = 32) {
    const totalChars = words.reduce((acc, w) => acc + w.word.length + 1, 0) - 1;
    let breakIndex = -1;

    if (totalChars > maxLineChars && words.length >= 5) {
        const midTarget = totalChars / 2;
        let runningChars = 0;
        let bestDiff = Infinity;

        for (let i = 0; i < words.length - 1; i++) {
            runningChars += words[i].word.length + 1;
            const diff = Math.abs(runningChars - midTarget);
            if (diff < bestDiff) {
                bestDiff = diff;
                breakIndex = i;
            }
        }
    }

    let line = '';
    for (let j = 0; j < words.length; j++) {
        line += words[j].word;
        if (j === breakIndex) line += '\\N';
        else if (j < words.length - 1) line += ' ';
    }
    return line;
}

function whisperJsonToAss(jsonData, stylePreset = 'random', videoMeta = null) {
    const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    const segments = data.transcription || [];
    const theme = resolveTheme(stylePreset);
    let ass = buildAssHeader(videoMeta);

    const allWords = [];
    for (const seg of segments) {
        const rawTokens = (seg.tokens || []).filter(t => t.text && !t.text.startsWith('[_'));
        let curWord = null;

        for (const t of rawTokens) {
            const text = t.text;
            const isNewWord = text.startsWith(' ') || (allWords.length === 0 && !curWord);
            const cleanText = text.trim();
            if (!cleanText) continue;

            const tStart = parseSrtTimestamp(t.timestamps?.from);
            const tEnd = parseSrtTimestamp(t.timestamps?.to);

            if (isNewWord && curWord) {
                allWords.push(curWord);
                curWord = null;
            }

            if (!curWord) {
                curWord = { word: cleanText, startSec: tStart, endSec: tEnd };
            } else {
                curWord.word += cleanText;
                curWord.endSec = Math.max(curWord.endSec, tEnd);
            }
        }
        if (curWord) allWords.push(curWord);
    }

    if (allWords.length === 0) return { ass, theme };

    const isVert = videoMeta ? videoMeta.isVertical : false;
    const maxCharsPerUnit = isVert ? 46 : 68;
    const maxWordsPerUnit = isVert ? 10 : 14;

    const units = [];
    let curUnit = [];

    for (let i = 0; i < allWords.length; i++) {
        const w = allWords[i];
        curUnit.push(w);
        const nextW = allWords[i + 1];

        const hasTerminator = /[.?!]$/.test(w.word);
        const hasClauseBreak = /[,;:]$/.test(w.word);
        const hasLongPause = nextW ? (nextW.startSec - w.endSec >= 0.55) : false;
        const curChars = curUnit.reduce((acc, item) => acc + item.word.length + 1, 0);

        let shouldSplit = false;
        if (hasTerminator) shouldSplit = true;
        else if (hasClauseBreak && (curUnit.length >= 4 || curChars >= 22)) shouldSplit = true;
        else if (hasLongPause && curUnit.length >= 3) shouldSplit = true;
        else if (curUnit.length >= maxWordsPerUnit || curChars >= maxCharsPerUnit) shouldSplit = true;

        if (shouldSplit) {
            units.push(curUnit);
            curUnit = [];
        }
    }

    if (curUnit.length > 0) {
        if (units.length > 0 && curUnit.length < 3) units[units.length - 1].push(...curUnit);
        else units.push(curUnit);
    }

    const wrapCharLimit = isVert ? 26 : 42;

    for (let uIdx = 0; uIdx < units.length; uIdx++) {
        const unit = units[uIdx];
        const N = unit.length;
        if (N === 0) continue;

        const unitStart = unit[0].startSec;
        let unitEnd = Math.max(unitStart + 1.4, unit[N - 1].endSec);

        if (uIdx + 1 < units.length) {
            const nextStart = units[uIdx + 1][0].startSec;
            if (unitEnd > nextStart) unitEnd = Math.max(unitStart + 0.5, nextStart);
        }

        const fullTextFormatted = formatUnitWordsWithWrap(unit, wrapCharLimit);
        ass += `Dialogue: 0,${formatAssTime(unitStart)},${formatAssTime(unitEnd)},${theme.name},,0,0,0,,${fullTextFormatted}\n`;
    }

    return { ass, theme };
}

function srtToAss(srtContent, stylePreset = 'random', videoMeta = null) {
    const cleanedSrt = cleanYouTubeRollingCaptions(srtContent);
    const cues = parseSrt(cleanedSrt || srtContent);
    const theme = resolveTheme(stylePreset);
    let ass = buildAssHeader(videoMeta);
    const isVert = videoMeta ? videoMeta.isVertical : false;
    const wrapCharLimit = isVert ? 26 : 42;

    for (let c = 0; c < cues.length; c++) {
        const cue = cues[c];
        const rawWords = cue.text.split(/\s+/).filter(w => w.trim().length > 0);
        if (rawWords.length === 0) continue;

        let cueEnd = Math.max(cue.startSec + 1.2, cue.endSec);
        if (c + 1 < cues.length && cueEnd > cues[c + 1].startSec) {
            cueEnd = Math.max(cue.startSec + 0.4, cues[c + 1].startSec);
        }

        const wordsObj = rawWords.map((w, idx) => ({ word: w, idx }));
        const fullTextFormatted = formatUnitWordsWithWrap(wordsObj, wrapCharLimit);
        ass += `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cueEnd)},${theme.name},,0,0,0,,${fullTextFormatted}\n`;
    }

    return { ass, theme };
}

function lrcToAss(lrcText, stylePreset = 'random', videoMeta = null) {
    const theme = resolveTheme(stylePreset);
    if (!lrcText) return { ass: '', theme };
    const rawLines = lrcText.split(/\r?\n/);
    const parsed = [];

    for (const line of rawLines) {
        const match = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/);
        if (match) {
            const min = parseInt(match[1], 10);
            const sec = parseInt(match[2], 10);
            const msStr = match[3] || '0';
            const secFraction = msStr.length === 2 ? parseInt(msStr, 10) / 100 : parseInt(msStr, 10) / 1000;
            const time = min * 60 + sec + secFraction;
            const text = match[4].trim();
            if (text) parsed.push({ time, text });
        }
    }

    parsed.sort((a, b) => a.time - b.time);
    let ass = buildAssHeader(videoMeta);
    const isVert = videoMeta ? videoMeta.isVertical : false;
    const wrapCharLimit = isVert ? 28 : 46;

    for (let i = 0; i < parsed.length; i++) {
        const cur = parsed[i];
        let nextTime = (i + 1 < parsed.length) ? parsed[i + 1].time : (cur.time + 5.0);
        let lineDuration = Math.max(1.2, nextTime - cur.time);
        if (lineDuration > 7.0) lineDuration = 5.0;
        const endTime = cur.time + lineDuration;

        const rawWords = cur.text.split(/\s+/).filter(w => w.trim().length > 0);
        if (rawWords.length === 0) continue;

        const wordsObj = rawWords.map((w, idx) => ({ word: w, idx }));
        const fullTextFormatted = formatUnitWordsWithWrap(wordsObj, wrapCharLimit);

        ass += `Dialogue: 0,${formatAssTime(cur.time)},${formatAssTime(endTime)},${theme.name},,0,0,0,,{\\fad(150,150)}${fullTextFormatted}\n`;
    }

    return { ass, theme };
}

async function burnSubtitleIntoVideo(videoPath, subSource, outputPath, options = {}) {
    const stylePreset = options.style || 'random';
    let assFile = null;
    let createdTempAss = false;
    let selectedTheme = null;

    try {
        const videoMeta = await probeVideoDimensions(videoPath);
        const renderMeta = {
            ...videoMeta,
            width: videoMeta.targetWidth || videoMeta.width,
            height: videoMeta.targetHeight || videoMeta.height
        };

        if (typeof subSource === 'string' && subSource.endsWith('.ass') && fs.existsSync(subSource)) {
            assFile = subSource;
        } else {
            let assContent = '';
            let themeResult = null;

            if (typeof subSource === 'string' && fs.existsSync(subSource)) {
                if (subSource.endsWith('.json')) {
                    const jsonData = JSON.parse(fs.readFileSync(subSource, 'utf8'));
                    const res = whisperJsonToAss(jsonData, stylePreset, renderMeta);
                    assContent = res.ass;
                    themeResult = res.theme;
                } else if (subSource.endsWith('.lrc')) {
                    const lrcText = fs.readFileSync(subSource, 'utf8');
                    const res = lrcToAss(lrcText, stylePreset, renderMeta);
                    assContent = res.ass;
                    themeResult = res.theme;
                } else {
                    const srtText = fs.readFileSync(subSource, 'utf8');
                    const res = srtToAss(srtText, stylePreset, renderMeta);
                    assContent = res.ass;
                    themeResult = res.theme;
                }
            } else if (typeof subSource === 'object' && subSource.transcription) {
                const res = whisperJsonToAss(subSource, stylePreset, renderMeta);
                assContent = res.ass;
                themeResult = res.theme;
            } else if (typeof subSource === 'string') {
                const isSrt = subSource.includes('-->');
                const isLrc = subSource.includes('[00:') || /\[\d{2}:\d{2}/.test(subSource);
                const res = isSrt
                    ? srtToAss(subSource, stylePreset, renderMeta)
                    : (isLrc ? lrcToAss(subSource, stylePreset, renderMeta) : srtToAss(subSource, stylePreset, renderMeta));
                assContent = res.ass;
                themeResult = res.theme;
            }

            selectedTheme = themeResult || resolveTheme(stylePreset);
            if (typeof options.onTheme === 'function') options.onTheme(selectedTheme);

            if (!assContent || assContent.trim().length === 0) {
                throw new Error('Failed to generate ASS subtitle file content.');
            }

            const tempDir = options.tempDir || path.dirname(outputPath);
            assFile = path.join(tempDir, `styled_${Date.now()}_${Math.random().toString(36).substring(7)}.ass`);
            fs.writeFileSync(assFile, assContent, 'utf8');
            createdTempAss = true;
        }

        const escapedAss = assFile.replace(/\\/g, '/').replace(/'/g, "\\'");
        const vfFilters = [];
        if (videoMeta.targetWidth !== videoMeta.width || videoMeta.targetHeight !== videoMeta.height) {
            vfFilters.push(`scale=${videoMeta.targetWidth}:${videoMeta.targetHeight}:flags=bicubic`);
        }
        if (videoMeta.fps > 60) {
            vfFilters.push('fps=60');
        }
        vfFilters.push(`ass='${escapedAss}'`);
        const vfArg = vfFilters.join(',');

        const videoDuration = videoMeta.duration || 120;

        await new Promise((resolve, reject) => {
            const ffArgs = [
                '-y',
                '-i', videoPath,
                '-vf', vfArg,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '21',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-threads', '0',
                '-movflags', '+faststart',
                '-progress', 'pipe:1',
                '-nostats',
                outputPath
            ];

            const proc = spawn('ffmpeg', ffArgs);
            let stdoutBuf = '';

            proc.stdout.on('data', chunk => {
                stdoutBuf += chunk.toString();
                const lines = stdoutBuf.split('\n');
                stdoutBuf = lines.pop();
                let outTimeUs = null;
                let speed = null;
                for (const l of lines) {
                    const [k, v] = l.split('=');
                    if (!k || !v) continue;
                    if (k.trim() === 'out_time_us') outTimeUs = parseInt(v.trim(), 10);
                    else if (k.trim() === 'speed') speed = v.trim();
                }
                if (typeof options.onProgress === 'function' && outTimeUs !== null && !isNaN(outTimeUs)) {
                    const curSec = outTimeUs / 1000000;
                    const pct = videoDuration > 0 ? Math.min(99, Math.max(1, Math.round((curSec / videoDuration) * 100))) : 50;
                    options.onProgress({ percent: pct, currentSec: curSec, targetDuration: videoDuration, speed });
                }
            });

            proc.on('close', code => {
                if (code === 0 && fs.existsSync(outputPath)) resolve();
                else reject(new Error(`FFmpeg subtitle burn exited with code ${code}`));
            });
            proc.on('error', reject);
        });

        return fs.existsSync(outputPath) ? outputPath : null;
    } finally {
        if (createdTempAss && assFile && fs.existsSync(assFile)) {
            try { fs.unlinkSync(assFile); } catch {}
        }
    }
}

async function renderThemePreview(themeKeyOrPreset, customText = '', outputPath = null, tempDir = null) {
    const isAll = !themeKeyOrPreset || ['all', 'showcase', 'list'].includes(String(themeKeyOrPreset).toLowerCase().trim());
    const targetDir = tempDir || (outputPath ? path.dirname(outputPath) : '/tmp');
    fs.mkdirSync(targetDir, { recursive: true });

    const finalImage = outputPath || path.join(targetDir, `theme_preview_${Date.now()}.jpg`);
    const assFile = path.join(targetDir, `preview_${Date.now()}.ass`);

    try {
        if (isAll) {
            const w = 1280;
            const h = 980;
            let stylesAss = `Style: Title,DejaVu Sans,30,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,40,1\nStyle: SubTitle,DejaVu Sans,18,&H009999AA&,&H009999AA&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,1,8,40,40,40,1\nStyle: Label,DejaVu Sans,20,&H00E0E0E0&,&H00E0E0E0&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,2,1,4,40,40,40,1\nStyle: Footer,DejaVu Sans,17,&H007A7A90&,&H007A7A90&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,1,0,2,40,40,40,1\n`;

            for (const key of THEME_KEYS) {
                const t = THEMES[key];
                const out = (t.borderStyle === 3) ? 5 : 4;
                const shd = (t.borderStyle === 3) ? 0 : 2;
                stylesAss += `Style: ${t.name},DejaVu Sans,32,${t.primary},${t.primary},${t.outline},${t.back},-1,0,0,0,100,100,0,0,${t.borderStyle},${out},${shd},5,20,20,20,1\n`;
            }

            let events = `Dialogue: 0,0:00:00.00,0:00:05.00,Title,,0,0,0,,{\\an8\\pos(640,36)}Ares-MD · Subtitle Themes Showcase\nDialogue: 0,0:00:00.00,0:00:05.00,SubTitle,,0,0,0,,{\\an8\\pos(640,78)}Preview available subtitle and karaoke styles\n`;
            const startY = 145;
            const stepY = 110;
            const sample = (customText && customText.trim().length > 0)
                ? customText.trim().replace(/\r?\n/g, ' ')
                : 'Ares-MD AI Subtitles · Dynamic & Precise';

            THEME_KEYS.forEach((key, idx) => {
                const t = THEMES[key];
                const y = startY + idx * stepY;
                events += `Dialogue: 0,0:00:00.00,0:00:05.00,Label,,0,0,0,,{\\an4\\pos(70,${y})}${idx + 1}. ${t.name.toUpperCase()}  \\h\\h{\\c&H888899&\\fs16}(${t.label})\\h\\h{\\c&H55FF99&\\fs15}whisper v ${key}\n`;
                events += `Dialogue: 0,0:00:00.00,0:00:05.00,${t.name},,0,0,0,,{\\an6\\pos(1210,${y})}${sample}\n`;
            });

            events += `Dialogue: 0,0:00:00.00,0:00:05.00,Footer,,0,0,0,,{\\an2\\pos(640,945)}To test any theme with custom text: ares theme <name> [text]\n`;
            const ass = `[Script Info]\nTitle: Themes Showcase\nScriptType: v4.00+\nWrapStyle: 0\nPlayResX: ${w}\nPlayResY: ${h}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${stylesAss}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}`;

            fs.writeFileSync(assFile, ass, 'utf8');
            const escapedAss = assFile.replace(/\\/g, '/').replace(/'/g, "\\'");
            const cmd = `ffmpeg -y -f lavfi -i color=c=0x0a0a0f:s=1280x980:d=1 -vf "ass='${escapedAss}'" -frames:v 1 -update 1 "${finalImage}"`;
            await execPromise(cmd, { timeout: 30000 });
            return { imagePath: fs.existsSync(finalImage) ? finalImage : null, theme: null, isAll: true };
        } else {
            const theme = resolveTheme(themeKeyOrPreset);
            const w = 1280;
            const h = 720;
            const fontSize = 48;
            const outline = (theme.borderStyle === 3) ? 6 : 5;
            const shadow = (theme.borderStyle === 3) ? 0 : 2;
            const stylesAss = `Style: ${theme.name},DejaVu Sans,${fontSize},${theme.primary},${theme.primary},${theme.outline},${theme.back},-1,0,0,0,100,100,0,0,${theme.borderStyle},${outline},${shadow},5,40,40,40,1\nStyle: Header,DejaVu Sans,26,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,3,1,8,40,40,40,1\nStyle: Muted,DejaVu Sans,20,&H00999999&,&H00999999&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1\n`;
            const cleanText = (customText && customText.trim().length > 0)
                ? customText.trim().replace(/\r?\n/g, '\\N')
                : `Ares-MD Subtitle Engine\\NTheme Preview: ${theme.label}`;
            const ass = `[Script Info]\nTitle: Ares-MD Theme Preview\nScriptType: v4.00+\nWrapStyle: 0\nPlayResX: ${w}\nPlayResY: ${h}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${stylesAss}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,Muted,,0,0,0,,{\\an8\\pos(640,50)}Ares-MD · Subtitle Theme Preview\nDialogue: 0,0:00:00.00,0:00:05.00,Header,,0,0,0,,{\\an8\\pos(640,95)}${theme.name.toUpperCase()} · ${theme.label}\nDialogue: 0,0:00:00.00,0:00:05.00,${theme.name},,0,0,0,,{\\an5\\pos(640,380)}${cleanText}\nDialogue: 0,0:00:00.00,0:00:05.00,Muted,,0,0,0,,{\\an2\\pos(640,660)}To use in video subtitles: ares whisper v <video> ${theme.key || themeKeyOrPreset}\n`;

            fs.writeFileSync(assFile, ass, 'utf8');
            const escapedAss = assFile.replace(/\\/g, '/').replace(/'/g, "\\'");
            const cmd = `ffmpeg -y -f lavfi -i color=c=0x0c0c12:s=1280x720:d=1 -vf "ass='${escapedAss}'" -frames:v 1 -update 1 "${finalImage}"`;
            await execPromise(cmd, { timeout: 30000 });
            return { imagePath: fs.existsSync(finalImage) ? finalImage : null, theme, isAll: false };
        }
    } finally {
        if (assFile && fs.existsSync(assFile)) {
            try { fs.unlinkSync(assFile); } catch {}
        }
    }
}

module.exports = {
    THEMES,
    THEME_KEYS,
    resolveTheme,
    formatAssTime,
    parseSrtTimestamp,
    probeVideoDimensions,
    buildAssHeader,
    cleanYouTubeRollingCaptions,
    parseSrt,
    whisperJsonToAss,
    srtToAss,
    lrcToAss,
    burnSubtitleIntoVideo,
    renderThemePreview
};
