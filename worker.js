const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
    processWhisper,
    processSongBurn,
    processMvRemix,
    processSpeed,
    processFixVideo,
    processCut,
    processRotate,
    processMp3,
    processTheme,
    processAudioMerge
} = require('./lib/processors');
const {
    normalizeMasterKey,
    isEncryptedFile,
    encryptFile,
    decryptFile,
    encryptJson,
    decryptJson
} = require('./lib/cryptoHelper');

const GITHUB_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
const CRYPTO_KEY = process.env.ARES_CRYPTO_KEY || '';
const HAS_CRYPTO = Boolean(normalizeMasterKey(CRYPTO_KEY));
const REPO = process.env.GITHUB_REPOSITORY || 'eulerx0/ares-cloud-engine';
const BUS_TAG = 'ares-live-bus';

// Keep Beast warm for 15 minutes of inactivity so follow-up commands start in 0s
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// Graceful rollover near the 6h GitHub Actions hard ceiling (only if active recently)
const MAX_GENERATION_MS = (5 * 60 + 45) * 60 * 1000;
// Auto-purge orphaned bus assets older than 60 minutes
const ASSET_MAX_AGE_MS = 60 * 60 * 1000;

const api = axios.create({
    baseURL: `https://api.github.com/repos/${REPO}`,
    headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Ares-Cloud-Beast/2.1'
    },
    timeout: 30000
});

let busReleaseId = null;
let busState = {
    beast: {
        status: 'awake',
        startedAt: Date.now(),
        heartbeat: Date.now(),
        encrypted: HAS_CRYPTO,
        specs: '4 vCPUs • 16 GB RAM • 10 Gbps Cloud'
    },
    jobs: {}
};

async function withRetry(fn, attempts = 3, delayMs = 1200) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const status = err?.response?.status;
            if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) {
                throw err;
            }
            if (i < attempts) {
                await new Promise(r => setTimeout(r, delayMs * i));
            }
        }
    }
    throw lastErr;
}

async function ensureBusRelease() {
    try {
        const res = await withRetry(() => api.get(`/releases/tags/${BUS_TAG}`));
        busReleaseId = res.data.id;
        try {
            const parsed = JSON.parse(res.data.body || '{}');
            if (parsed && parsed.jobs) {
                const now = Date.now();
                for (const [jid, jinfo] of Object.entries(parsed.jobs)) {
                    // Mark orphaned running jobs from crashed sessions as error
                    if (jinfo.status === 'running' && jinfo.updatedAt && now - jinfo.updatedAt > 20 * 60 * 1000) {
                        jinfo.status = 'error';
                        jinfo.error = 'Worker restarted before job completed.';
                        jinfo.updatedAt = now;
                    }
                    busState.jobs[jid] = jinfo;
                }
            }
        } catch (_) {}
    } catch (err) {
        if (err.response && err.response.status === 404) {
            const createRes = await withRetry(() => api.post('/releases', {
                tag_name: BUS_TAG,
                name: '⚡ Ares Cloud Engine — Live Telemetry Bus',
                body: JSON.stringify(busState, null, 2),
                draft: false,
                prerelease: true
            }));
            busReleaseId = createRes.data.id;
        } else {
            throw err;
        }
    }
}

let lastStatePush = 0;
async function pushBusState(force = false) {
    const now = Date.now();
    if (!force && now - lastStatePush < 1200) return;
    lastStatePush = now;
    busState.beast.heartbeat = now;

    // Prune finished jobs older than 20 minutes from state JSON
    for (const [jid, jinfo] of Object.entries(busState.jobs)) {
        if (jinfo.updatedAt && now - jinfo.updatedAt > 20 * 60 * 1000) {
            delete busState.jobs[jid];
        }
    }

    try {
        await withRetry(() => api.patch(`/releases/${busReleaseId}`, {
            body: JSON.stringify(busState, null, 2)
        }), 2, 800);
    } catch (e) {
        console.warn('[BUS] State update warning:', e.message);
    }
}

async function downloadAssetToFile(assetId, destPath) {
    return withRetry(async () => {
        const res = await axios.get(`https://api.github.com/repos/${REPO}/releases/assets/${assetId}`, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/octet-stream',
                'User-Agent': 'Ares-Cloud-Beast/2.1'
            },
            responseType: 'stream',
            timeout: 300000,
            maxRedirects: 5
        });

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(destPath);
            res.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
            res.data.on('error', reject);
        });
    }, 3, 1500);
}

async function deleteAsset(assetId) {
    try {
        await api.delete(`/releases/assets/${assetId}`);
    } catch (_) {}
}

async function uploadFileAsAsset(filePath, assetName, existingAssets = null) {
    // Delete any existing asset with the same name first to avoid 422 already_exists
    try {
        let assets = existingAssets;
        if (!assets) {
            const relRes = await api.get(`/releases/${busReleaseId}`);
            assets = relRes.data.assets || [];
        }
        const dup = assets.find(a => a.name === assetName);
        if (dup) await deleteAsset(dup.id);
    } catch (_) {}

    return withRetry(async () => {
        const stat = fs.statSync(filePath);
        const stream = fs.createReadStream(filePath);
        const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${busReleaseId}/assets?name=${encodeURIComponent(assetName)}`;

        const res = await axios.post(uploadUrl, stream, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size,
                'User-Agent': 'Ares-Cloud-Beast/2.1'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 600000
        });
        return res.data;
    }, 3, 2000);
}

async function cleanupStaleAssets(assets) {
    const now = Date.now();
    for (const a of assets || []) {
        const ts = new Date(a.updated_at || a.created_at).getTime();
        if (!isNaN(ts) && now - ts > ASSET_MAX_AGE_MS) {
            console.log(`🧹 Purging stale release asset: ${a.name}`);
            await deleteAsset(a.id);
        }
    }
}

async function fetchAndDecryptInputAsset(asset, destPlainPath) {
    const rawTmp = `${destPlainPath}.raw`;
    try {
        await downloadAssetToFile(asset.id, rawTmp);
        await deleteAsset(asset.id);
        if (isEncryptedFile(rawTmp)) {
            if (!HAS_CRYPTO) throw new Error('Encrypted input received, but ARES_CRYPTO_KEY is not configured.');
            await decryptFile(rawTmp, destPlainPath, CRYPTO_KEY);
        } else {
            fs.renameSync(rawTmp, destPlainPath);
        }
    } finally {
        try { if (fs.existsSync(rawTmp)) fs.unlinkSync(rawTmp); } catch (_) {}
    }
}

async function executeJob(rawJob, assets) {
    let job = rawJob;
    if (rawJob && rawJob.encrypted) {
        if (!HAS_CRYPTO) throw new Error('Encrypted job received without ARES_CRYPTO_KEY.');
        job = decryptJson(rawJob, CRYPTO_KEY);
    }

    const jobId = job.id;
    console.log(`\n🚀 [JOB START] ID: ${jobId} | Action: ${job.action}`);

    busState.jobs[jobId] = {
        status: 'running',
        action: job.action,
        stage: '⚡ Beast claimed job — initializing pipeline...',
        percent: 5,
        speed: '',
        detail: '',
        updatedAt: Date.now()
    };
    await pushBusState(true);

    let localInPath = null;
    let localAudioPath = null;
    let encryptedOutPath = null;
    let result = null;

    try {
        if (job.inputAssetName) {
            const inAsset = assets.find(a => a.name === job.inputAssetName);
            if (!inAsset) throw new Error(`Uploaded input file (${job.inputAssetName}) not found on bus.`);
            const ext = path.extname(job.fileName || job.inputAssetName.replace(/\.enc$/i, '')) || '.mp4';
            localInPath = `/tmp/ares_work/in_${jobId}${ext}`;
            busState.jobs[jobId].stage = '🔐 Fetching & decrypting input inside 16GB RAM workspace...';
            busState.jobs[jobId].percent = 10;
            await pushBusState(true);
            await fetchAndDecryptInputAsset(inAsset, localInPath);
        }

        if (job.audioAssetName) {
            const audAsset = assets.find(a => a.name === job.audioAssetName);
            if (audAsset) {
                localAudioPath = `/tmp/ares_work/aud_${jobId}.mp3`;
                await fetchAndDecryptInputAsset(audAsset, localAudioPath);
            }
        }

        const onProgress = async ({ stage, percent, speed }) => {
            busState.jobs[jobId] = {
                ...busState.jobs[jobId],
                status: 'running',
                stage: stage || busState.jobs[jobId].stage,
                percent: percent ?? busState.jobs[jobId].percent,
                speed: speed ?? busState.jobs[jobId].speed,
                updatedAt: Date.now()
            };
            await pushBusState(false);
        };

        switch (job.action) {
            case 'whisper':
                result = await processWhisper(job, localInPath, onProgress);
                break;
            case 'song':
                result = await processSongBurn(job, localInPath, onProgress);
                break;
            case 'mv':
                result = await processMvRemix(job, localInPath, localAudioPath, onProgress);
                break;
            case 'slow':
            case 'sped':
                result = await processSpeed(job, localInPath, onProgress);
                break;
            case 'fixvideo':
            case 'compress':
                result = await processFixVideo(job, localInPath, onProgress);
                break;
            case 'cut':
                result = await processCut(job, localInPath, onProgress);
                break;
            case 'rotate':
                result = await processRotate(job, localInPath, onProgress);
                break;
            case 'mp3':
                result = await processMp3(job, localInPath, onProgress);
                break;
            case 'theme':
                result = await processTheme(job, onProgress);
                break;
            case 'setaudio':
            case 'mixaudio':
                result = await processAudioMerge(job, localInPath, localAudioPath, onProgress);
                break;
            default:
                throw new Error(`Unknown action: ${job.action}`);
        }

        if (!result || !result.outputPath || !fs.existsSync(result.outputPath)) {
            throw new Error('Processor finished without producing an output file.');
        }

        busState.jobs[jobId].stage = HAS_CRYPTO
            ? '🔐 Encrypting (AES-256-GCM) & uploading result to bus...'
            : '☁️ Uploading finished result to transfer bus...';
        busState.jobs[jobId].percent = 99;
        await pushBusState(true);

        const outExt = path.extname(result.outputFileName) || '.mp4';
        let uploadSourcePath = result.outputPath;
        let outAssetName = `out_${jobId}${outExt}`;

        if (HAS_CRYPTO) {
            encryptedOutPath = `${result.outputPath}.enc`;
            await encryptFile(result.outputPath, encryptedOutPath, CRYPTO_KEY);
            uploadSourcePath = encryptedOutPath;
            outAssetName = `out_${jobId}${outExt}.enc`;
        }

        const uploadedAsset = await uploadFileAsAsset(uploadSourcePath, outAssetName);
        const plainSize = fs.statSync(result.outputPath).size;

        const sensitiveResultMeta = {
            outputFileName: result.outputFileName,
            textPreview: result.textPreview || null,
            meta: result.meta || null
        };

        busState.jobs[jobId] = {
            status: 'done',
            action: job.action,
            stage: '✅ Completed! Ready for instant download.',
            percent: 100,
            encrypted: HAS_CRYPTO,
            outputAssetId: uploadedAsset.id,
            outputAssetName: outAssetName,
            outputSize: plainSize,
            ...(HAS_CRYPTO
                ? { encResult: encryptJson({ id: jobId, ...sensitiveResultMeta }, CRYPTO_KEY) }
                : sensitiveResultMeta),
            updatedAt: Date.now()
        };
        await pushBusState(true);
        console.log(`✅ [JOB DONE] ID: ${jobId} (${plainSize} bytes)`);
    } catch (err) {
        console.error(`❌ [JOB ERROR] ID: ${jobId}:`, err.message);
        busState.jobs[jobId] = {
            status: 'error',
            action: job.action,
            stage: '❌ Processing failed',
            error: err.message,
            percent: 0,
            updatedAt: Date.now()
        };
        await pushBusState(true);
    } finally {
        try { if (localInPath && fs.existsSync(localInPath)) fs.unlinkSync(localInPath); } catch (_) {}
        try { if (localAudioPath && fs.existsSync(localAudioPath)) fs.unlinkSync(localAudioPath); } catch (_) {}
        try { if (encryptedOutPath && fs.existsSync(encryptedOutPath)) fs.unlinkSync(encryptedOutPath); } catch (_) {}
        try { if (result?.outputPath && fs.existsSync(result.outputPath)) fs.unlinkSync(result.outputPath); } catch (_) {}
    }
}

async function respawnNextGeneration() {
    console.log('🔥 [PHOENIX] Spawning next Beast generation for active session...');
    try {
        await api.post('/actions/workflows/engine.yml/dispatches', { ref: 'main' });
    } catch (e) {
        console.warn('[PHOENIX] Respawn warning:', e.message);
    }
}

let isShuttingDown = false;
async function gracefulSleep(reason = 'Shutdown signal received') {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`💤 ${reason}. Marking Beast sleeping...`);
    busState.beast.status = 'sleeping';
    await pushBusState(true);
}

process.on('SIGTERM', async () => { await gracefulSleep('SIGTERM received'); process.exit(0); });
process.on('SIGINT', async () => { await gracefulSleep('SIGINT received'); process.exit(0); });

async function mainLoop() {
    console.log(`⚡ Ares Cloud Beast v2.1 initializing (E2E Crypto: ${HAS_CRYPTO ? 'AES-256-GCM ON' : 'OFF'})...`);
    if (process.env.YT_COOKIES && process.env.YT_COOKIES.trim().length > 20) {
        fs.writeFileSync(path.join(process.cwd(), 'cookies.txt'), process.env.YT_COOKIES, 'utf8');
        console.log('🍪 Loaded YouTube cookies.txt from encrypted secret.');
    }
    await ensureBusRelease();

    busState.beast.status = 'awake';
    busState.beast.startedAt = Date.now();
    busState.beast.encrypted = HAS_CRYPTO;
    await pushBusState(true);
    console.log('🦁 Beast is AWAKE and listening for commands on bus!');

    const bootTime = Date.now();
    let lastActivityTime = Date.now();
    let lastCleanupTime = 0;

    while (!isShuttingDown) {
        try {
            const relRes = await api.get(`/releases/${busReleaseId}`);
            const assets = relRes.data.assets || [];

            if (Date.now() - lastCleanupTime > 5 * 60 * 1000) {
                lastCleanupTime = Date.now();
                await cleanupStaleAssets(assets);
            }

            const sleepAsset = assets.find(a => a.name === 'cmd_sleep.json');
            if (sleepAsset) {
                await deleteAsset(sleepAsset.id);
                console.log('💤 Sleep command received from bot. Entering deep sleep...');
                break;
            }

            const jobAssets = assets
                .filter(a => a.name.startsWith('job_') && a.name.endsWith('.json'))
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

            if (jobAssets.length > 0) {
                for (const jAsset of jobAssets) {
                    const tmpJobPath = `/tmp/ares_work/${jAsset.name}`;
                    await downloadAssetToFile(jAsset.id, tmpJobPath);
                    await deleteAsset(jAsset.id);
                    const jobData = JSON.parse(fs.readFileSync(tmpJobPath, 'utf8'));
                    try { fs.unlinkSync(tmpJobPath); } catch (_) {}

                    lastActivityTime = Date.now();
                    await executeJob(jobData, assets);
                    lastActivityTime = Date.now();
                }
            } else if (Date.now() - lastStatePush > 12000) {
                await pushBusState(true);
            }

            const now = Date.now();
            if (now - lastActivityTime > IDLE_TIMEOUT_MS) {
                console.log('💤 No tasks received for 15 minutes. Beast going to sleep cleanly.');
                break;
            }

            if (now - bootTime > MAX_GENERATION_MS) {
                if (now - lastActivityTime < 5 * 60 * 1000) {
                    await respawnNextGeneration();
                }
                break;
            }
        } catch (loopErr) {
            console.warn('[LOOP] Poll warning:', loopErr.message);
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    await gracefulSleep('Idle timeout / cycle finished');
    console.log('✅ Beast is now sleeping peacefully.');
}

mainLoop().catch(async err => {
    console.error('Fatal worker error:', err);
    await gracefulSleep('Fatal worker error');
    process.exit(1);
});
