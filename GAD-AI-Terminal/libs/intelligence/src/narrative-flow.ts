import type { NarrativeTag } from '@lib/narrative';
import type { NarrativeFlow } from './types';

// Track volume by narrative tag over time
interface NarrativeSnapshot {
  ts: number;
  volumes: Partial<Record<NarrativeTag, number>>;
}

const snapshots: NarrativeSnapshot[] = [];

export function recordNarrativeVolume(tag: NarrativeTag, volumeUsd: number): void {
  const now = Date.now();
  let snap = snapshots.find(s => now - s.ts < 60_000); // bucket by minute
  if (!snap) {
    snap = { ts: now, volumes: {} };
    snapshots.push(snap);
    // Keep last 48 hours
    const cutoff = now - 48 * 3600_000;
    while (snapshots.length > 0 && snapshots[0].ts < cutoff) snapshots.shift();
  }
  snap.volumes[tag] = (snap.volumes[tag] ?? 0) + volumeUsd;
}

export function getNarrativeFlow(tag: NarrativeTag, currentVolume24h: number): NarrativeFlow {
  const now = Date.now();
  const prev24h = now - 24 * 3600_000;
  const prev48h = now - 48 * 3600_000;

  const sumVolume = (from: number, to: number): number =>
    snapshots
      .filter(s => s.ts >= from && s.ts < to)
      .reduce((sum, s) => sum + (s.volumes[tag] ?? 0), 0);

  const tagVolume24h = sumVolume(prev24h, now) || currentVolume24h;
  const tagVolumePrev24h = sumVolume(prev48h, prev24h);

  const tagVolumeChange = tagVolumePrev24h > 0
    ? ((tagVolume24h - tagVolumePrev24h) / tagVolumePrev24h) * 100
    : 0;

  const capitalFlowing = tagVolumeChange > 20; // >20% volume increase = capital inflow

  // Rank narratives by 24h volume
  const allTags = Object.keys(
    snapshots
      .filter(s => s.ts >= prev24h)
      .reduce((acc, s) => { Object.assign(acc, s.volumes); return acc; }, {} as any)
  ) as NarrativeTag[];

  const volumeByTag = allTags.map(t => ({
    t,
    v: sumVolume(prev24h, now),
  })).sort((a, b) => b.v - a.v);

  const narrativeRank = (volumeByTag.findIndex(x => x.t === tag) + 1) || 99;

  return { tag, tagVolume24h, tagVolumeChange, capitalFlowing, narrativeRank };
}

// Returns which narrative is currently receiving most capital
export function getTopNarrative(): NarrativeTag | null {
  const now = Date.now();
  const prev24h = now - 24 * 3600_000;
  const aggregated: Partial<Record<NarrativeTag, number>> = {};

  for (const snap of snapshots.filter(s => s.ts >= prev24h)) {
    for (const [tag, vol] of Object.entries(snap.volumes) as [NarrativeTag, number][]) {
      aggregated[tag] = (aggregated[tag] ?? 0) + vol;
    }
  }

  let topTag: NarrativeTag | null = null;
  let topVol = 0;
  for (const [tag, vol] of Object.entries(aggregated) as [NarrativeTag, number][]) {
    if (vol > topVol) { topVol = vol; topTag = tag; }
  }
  return topTag;
}
