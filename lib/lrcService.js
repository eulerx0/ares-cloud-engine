const axios = require('axios');
const yts = require('yt-search');

function cleanSearchQuery(query) {
    return (query || '')
        .replace(/\((?:official|music|video|audio|lyrics|hd|4k|remastered)[^)]*\)/gi, '')
        .replace(/\[(?:official|music|video|audio|lyrics|hd|4k|remastered)[^\]]*\]/gi, '')
        .replace(/\b(?:ft\.|feat\.|featuring)\b[^-]+/gi, '')
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchLyricsFromLRCLIB(query, targetDuration = null) {
    try {
        const cleanQuery = cleanSearchQuery(query);
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanQuery || query)}`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Ares-Cloud-Engine/2.0' },
            timeout: 10000
        });

        if (!Array.isArray(res.data) || res.data.length === 0) return null;

        const syncedItems = res.data.filter(item => item && item.syncedLyrics);
        if (syncedItems.length === 0) return null;

        if (targetDuration) {
            syncedItems.sort((a, b) => Math.abs((a.duration || 0) - targetDuration) - Math.abs((b.duration || 0) - targetDuration));
        }

        return syncedItems[0];
    } catch (err) {
        console.warn('[LRCLIB] Search failed:', err.message);
        return null;
    }
}

async function searchLyricsLRCLIB(query, limit = 7) {
    try {
        const cleanQuery = cleanSearchQuery(query);
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanQuery || query)}`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Ares-Cloud-Engine/2.0' },
            timeout: 10000
        });

        if (!Array.isArray(res.data) || res.data.length === 0) return [];

        const uniqueResults = [];
        const seen = new Set();
        for (const item of res.data) {
            if (!item || !item.syncedLyrics) continue;
            const key = `${(item.trackName || '').toLowerCase()}_${(item.artistName || '').toLowerCase()}_${item.duration}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
            if (uniqueResults.length >= limit) break;
        }

        return uniqueResults;
    } catch (err) {
        console.warn('[LRCLIB] Search error:', err.message);
        return [];
    }
}

async function findBestYouTubeMatch(lrcItem) {
    const mainArtist = (lrcItem.artistName || '').split(/[,&]/)[0].trim();
    const trackName = lrcItem.trackName || '';
    const queries = [
        `${mainArtist} ${trackName} Official Music Video`,
        `${lrcItem.artistName} ${trackName}`,
        `${mainArtist} ${trackName}`
    ];

    const targetDuration = lrcItem.duration || 0;

    for (const q of queries) {
        try {
            const search = await yts(q);
            const videos = (search.videos || []).slice(0, 8);
            if (videos.length === 0) continue;

            const scored = videos.map(v => {
                let score = 0;
                const diff = Math.abs(v.seconds - targetDuration);

                if (diff <= 2) score += 100;
                else if (diff <= 5) score += 70;
                else if (diff <= 10) score += 40;
                else if (diff <= 20) score += 10;
                else score -= 50;

                const titleLower = v.title.toLowerCase();
                if (titleLower.includes('official music video') || titleLower.includes('official video')) score += 30;
                if (titleLower.includes('official audio')) score += 15;

                const authorLower = v.author.name.toLowerCase();
                if (authorLower.includes(mainArtist.toLowerCase())) score += 25;

                if (v.views > 0) score += Math.min(15, Math.log10(v.views) * 2);

                return { video: v, score, diff };
            });

            scored.sort((a, b) => b.score - a.score);
            if (scored[0] && scored[0].score > 30) {
                return scored[0].video;
            }
        } catch (e) {
            console.warn('[YOUTUBE] Match search failed:', e.message);
        }
    }
    return null;
}

module.exports = {
    cleanSearchQuery,
    fetchLyricsFromLRCLIB,
    searchLyricsLRCLIB,
    findBestYouTubeMatch
};
