import { Pool, QueryResult, QueryResultRow } from 'pg';
export declare function query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
export declare function transaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T>;
export declare function getPool(): Pool;
