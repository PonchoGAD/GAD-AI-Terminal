import type { HolderVelocity } from './types';
export declare function recordHolderCount(mint: string, count: number): void;
export declare function fetchHolderCount(mint: string, apiKey: string): Promise<number>;
export declare function calculateHolderVelocity(mint: string, currentCount: number): HolderVelocity;
