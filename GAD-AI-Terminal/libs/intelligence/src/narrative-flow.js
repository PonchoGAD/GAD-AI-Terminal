"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordNarrativeVolume = recordNarrativeVolume;
exports.getNarrativeFlow = getNarrativeFlow;
exports.getTopNarrative = getTopNarrative;
const snapshots = [];
function recordNarrativeVolume(tag, volumeUsd) {
    const now = Date.now();
    let snap = snapshots.find(s => now - s.ts < 60000); // bucket by minute
    if (!snap) {
        snap = { ts: now, volumes: {} };
        snapshots.push(snap);
        // Keep last 48 hours
        const cutoff = now - 48 * 3600000;
        while (snapshots.length > 0 && snapshots[0].ts < cutoff)
            snapshots.shift();
    }
    snap.volumes[tag] = (snap.volumes[tag] ?? 0) + volumeUsd;
}
function getNarrativeFlow(tag, currentVolume24h) {
    const now = Date.now();
    const prev24h = now - 24 * 3600000;
    const prev48h = now - 48 * 3600000;
    const sumVolume = (from, to) => snapshots
        .filter(s => s.ts >= from && s.ts < to)
        .reduce((sum, s) => sum + (s.volumes[tag] ?? 0), 0);
    const tagVolume24h = sumVolume(prev24h, now) || currentVolume24h;
    const tagVolumePrev24h = sumVolume(prev48h, prev24h);
    const tagVolumeChange = tagVolumePrev24h > 0
        ? ((tagVolume24h - tagVolumePrev24h) / tagVolumePrev24h) * 100
        : 0;
    const capitalFlowing = tagVolumeChange > 20; // >20% volume increase = capital inflow
    // Rank narratives by 24h volume
    const allTags = Object.keys(snapshots
        .filter(s => s.ts >= prev24h)
        .reduce((acc, s) => { Object.assign(acc, s.volumes); return acc; }, {}));
    const volumeByTag = allTags.map(t => ({
        t,
        v: sumVolume(prev24h, now),
    })).sort((a, b) => b.v - a.v);
    const narrativeRank = (volumeByTag.findIndex(x => x.t === tag) + 1) || 99;
    return { tag, tagVolume24h, tagVolumeChange, capitalFlowing, narrativeRank };
}
// Returns which narrative is currently receiving most capital
function getTopNarrative() {
    const now = Date.now();
    const prev24h = now - 24 * 3600000;
    const aggregated = {};
    for (const snap of snapshots.filter(s => s.ts >= prev24h)) {
        for (const [tag, vol] of Object.entries(snap.volumes)) {
            aggregated[tag] = (aggregated[tag] ?? 0) + vol;
        }
    }
    let topTag = null;
    let topVol = 0;
    for (const [tag, vol] of Object.entries(aggregated)) {
        if (vol > topVol) {
            topVol = vol;
            topTag = tag;
        }
    }
    return topTag;
}
