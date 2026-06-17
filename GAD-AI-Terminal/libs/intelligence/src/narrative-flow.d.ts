import type { NarrativeTag } from '@lib/narrative';
import type { NarrativeFlow } from './types';
export declare function recordNarrativeVolume(tag: NarrativeTag, volumeUsd: number): void;
export declare function getNarrativeFlow(tag: NarrativeTag, currentVolume24h: number): NarrativeFlow;
export declare function getTopNarrative(): NarrativeTag | null;
