const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
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
} = require('./lib/processors');

const GITHUB_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'eulerx0/ares-cloud-engine';
const BUS_TAG = 'ares-live-bus';

// Keep Beast awake for 25 minutes of inactivity so back-to-back commands execute with 0s boot time!
const IDLE_TIMEOUT_MS = 25 * 60 * 1000;
// Max runtime before Phoenix handover (5 hours 45 minutes)
const MAX_GENERATION_MS = (5 * 60 + 45) * 60 * 1000;

const api = axios.create({
    baseURL: `https://api.github.com/repos/${REPO}`,
    headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Ares-Cloud-Beast/2.0'
    },
    timeout: 30000
});

let busReleaseId = null;
let busState = {
    beast: {
        status: 'awake',
        startedAt: Date.now(),
        heartbeat: Date.now(),
        specs: '4 vCPUs • 16 GB RAM • 10 Gbps Cloud'
    },
    jobs: {}
};

async function ensureBusRelease() {
    try {
        const res = await api.get(`/releases/tags/${BUS_TAG}`);
        busReleaseId = res.data.id;
        try {
            const parsed = JSON.parse(res.data.body || '{}');
            if (parsed && parsed.jobs) {
                busState.jobs = parsed.jobs;
            }
        } catch (_) {}
    } catch (err) {
        if (err.response && err.response.status === 404) {
            const createRes = await api.post('/releases', {
                tag_name: BUS_TAG,
                name: '⚡ Ares Cloud Engine — Live Telemetry Bus',
                body: JSON.stringify(busState, null, 2),
                draft: false,
                prerelease: true
            });
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
        await api.patch(`/releases/${busReleaseId}`, {
            body: JSON.stringify(busState, null, 2)
        });
    } catch (e) {
        console.warn('[BUS] State update warning:', e.message);
    }
}

async function downloadAssetToFile(assetId, destPath) {
    const res = await axios.get(`https://api.github.com/repos/${REPO}/releases/assets/${assetId}`, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/octet-stream',
            'User-Agent': 'Ares-Cloud-Beast/2.0'
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
    });
}

async function uploadFileAsAsset(filePath, assetName) {
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${busReleaseId}/assets?name=${encodeURIComponent(assetName)}`;

    const res = await axios.post(uploadUrl, stream, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'User-Agent': 'Ares-Cloud-Beast/2.0'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000
    });
    return res.data;
}

async function deleteAsset(assetId) {
    try {
        await api.delete(`/releases/assets/${assetId}`);
    } catch (_) {}
}

async function executeJob(job, assets) {
    const jobId = job.id;
    console.log(`\n🚀 [JOB START] ID: ${jobId} | Action: ${job.action}`);

    busState.jobs[jobId] = {
        status: 'running',
        action: job.action,
        stage: '⚡ Beast claimed job — initializing pipeline...',
        percent: 5,
        speed: '',
        detail: job.fileName || job.query || job.url || '',
        updatedAt: Date.now()
    };
    await pushBusState(true);

    let localInPath = null;
    let localAudioPath = null;
    let result = null;

    try {
        // Check if job has uploaded input asset(s)
        if (job.inputAssetName) {
            const inAsset = assets.find(a => a.name === job.inputAssetName);
            if (!inAsset) throw new Error(`Uploaded input file (${job.inputAssetName}) not found on bus.`);
            const ext = path.extname(job.fileName || job.inputAssetName) || '.mp4';
            localInPath = `/tmp/ares_work/in_${jobId}${ext}`;
            busState.jobs[jobId].stage = '📥 Fetching uploaded file into 16GB RAM workspace...';
            busState.jobs[jobId].percent = 10;
            await pushBusState(true);
            await downloadAssetToFile(inAsset.id, localInPath);
            await deleteAsset(inAsset.id);
        }

        if (job.audioAssetName) {
            const audAsset = assets.find(a => a.name === job.audioAssetName);
            if (audAsset) {
                localAudioPath = `/tmp/ares_work/aud_${jobId}.mp3`;
                await downloadAssetToFile(audAsset.id, localAudioPath);
                await deleteAsset(audAsset.id);
            }
        }

        const onProgress = async ({ stage, percent, speed, detail }) => {
            busState.jobs[jobId] = {
                ...busState.jobs[jobId],
                status: 'running',
                stage: stage || busState.jobs[jobId].stage,
                percent: percent ?? busState.jobs[jobId].percent,
                speed: speed ?? busState.jobs[jobId].speed,
                detail: detail ?? busState.jobs[jobId].detail,
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
            case 'cut':
                result = await processCut(job, localInPath, onProgress);
                break;
            case 'fps60':
                result = await processFps(job, localInPath, onProgress);
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

        busState.jobs[jobId].stage = '☁️ Uploading finished result to high-speed transfer bus...';
        busState.jobs[jobId].percent = 99;
        await pushBusState(true);

        const outExt = path.extname(result.outputFileName) || '.mp4';
        const outAssetName = `out_${jobId}${outExt}`;
        const uploadedAsset = await uploadFileAsAsset(result.outputPath, outAssetName);

        busState.jobs[jobId] = {
            status: 'done',
            action: job.action,
            stage: '✅ Completed! Ready for instant download.',
            percent: 100,
            outputAssetId: uploadedAsset.id,
            outputAssetName: outAssetName,
            outputFileName: result.outputFileName,
            outputSize: fs.statSync(result.outputPath).size,
            textPreview: result.textPreview || null,
            updatedAt: Date.now()
        };
        await pushBusState(true);
        console.log(`✅ [JOB DONE] ID: ${jobId} -> ${result.outputFileName}`);
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
        try { if (result?.outputPath && fs.existsSync(result.outputPath)) fs.unlinkSync(result.outputPath); } catch (_) {}
    }
}

async function respawnNextGeneration() {
    console.log('🔥 [PHOENIX] Spawning next Beast generation for uninterrupted session...');
    try {
        await api.post('/actions/workflows/engine.yml/dispatches', {
            ref: 'main'
        });
    } catch (e) {
        console.warn('[PHOENIX] Respawn warning:', e.message);
    }
}

async function mainLoop() {
    console.log('⚡ Ares Cloud Beast v2.0 initializing...');
    if (process.env.YT_COOKIES && process.env.YT_COOKIES.trim().length > 20) {
        fs.writeFileSync(path.join(process.cwd(), 'cookies.txt'), process.env.YT_COOKIES, 'utf8');
        console.log('🍪 Loaded YouTube cookies.txt from encrypted secret.');
    }
    await ensureBusRelease();

    busState.beast.status = 'awake';
    busState.beast.startedAt = Date.now();
    await pushBusState(true);
    console.log('🦁 Beast is AWAKE and listening for commands on bus!');

    const bootTime = Date.now();
    let lastActivityTime = Date.now();

    while (true) {
        try {
            const relRes = await api.get(`/releases/${busReleaseId}`);
            const assets = relRes.data.assets || [];

            // Check for sleep signal
            const sleepAsset = assets.find(a => a.name === 'cmd_sleep.json');
            if (sleepAsset) {
                await deleteAsset(sleepAsset.id);
                console.log('💤 Sleep command received from PC. Entering deep sleep...');
                break;
            }

            // Find any queued job_{id}.json
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
            } else {
                // Periodic heartbeat every 12s while idle
                if (Date.now() - lastStatePush > 12000) {
                    await pushBusState(true);
                }
            }

            const now = Date.now();
            // 1. Check idle timeout (25 minutes without jobs -> go to sleep legally!)
            if (now - lastActivityTime > IDLE_TIMEOUT_MS) {
                console.log('💤 No tasks received for 25 minutes. Beast going to sleep to save resources.');
                break;
            }

            // 2. Check Phoenix handover (if session is still active near 5h45m limit)
            if (now - bootTime > MAX_GENERATION_MS) {
                if (now - lastActivityTime < 10 * 60 * 1000) {
                    await respawnNextGeneration();
                }
                break;
            }
        } catch (loopErr) {
            console.warn('[LOOP] Poll warning:', loopErr.message);
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    busState.beast.status = 'sleeping';
    await pushBusState(true);
    console.log('✅ Beast is now sleeping peacefully.');
}

mainLoop().catch(err => {
    console.error('Fatal worker error:', err);
    process.exit(1);
});
