import type { Drawing } from './chart-drawings';

// Lamport counter＋writer 全序；時間只用於顯示。舊資料以時間
// 轉成 legacy counter，第一次修改即升級，不需整份遷移。
export type Revision = string;
export interface DrawingTombstone {
    revision: Revision;
    updatedAt: number;
}
export type Tombstone = number | DrawingTombstone;

export function legacyRevision(at: number): Revision {
    return `${Math.max(0, Math.floor(at)).toString().padStart(16, '0')}:legacy`;
}

export function drawingRevision(d: Drawing): Revision {
    return d.revision ?? legacyRevision(d.updatedAt);
}

export function tombRevision(t: Tombstone): Revision {
    return typeof t === 'number' ? legacyRevision(t) : t.revision;
}

export function isRevision(v: unknown): v is Revision {
    return typeof v === 'string' && /^\d{16}:[\w-]+$/.test(v);
}

export function isTombstone(v: unknown): v is Tombstone {
    if (typeof v === 'number') return Number.isFinite(v);
    if (!v || typeof v !== 'object' || 'id' in v) return false;
    const t = v as DrawingTombstone;
    return isRevision(t.revision) && Number.isFinite(t.updatedAt);
}
