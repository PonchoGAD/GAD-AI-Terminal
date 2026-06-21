export * from './types';
export * from './scoring';
export * from './aggregator';
export * from './generator';
export * from './db';
export { fetchGdelt } from './sources/gdelt';
export { fetchGoogleNews } from './sources/google-news';
import { TrendCluster } from './types';
export declare function runTrendCycle(generateIdeas?: boolean): Promise<TrendCluster[]>;
