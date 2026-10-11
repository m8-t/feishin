export const JUKEBOX_CHUNK_SIZE = 50;

export type QueueSyncPlan =
    | { ids: string[]; type: 'append' }
    | { ids: string[]; type: 'replace' }
    | { index: number; type: 'remove' }
    | { type: 'none' };

export function chunkIds(ids: readonly string[], size: number = JUKEBOX_CHUNK_SIZE): string[][] {
    if (!(size >= 1)) {
        throw new RangeError(`Chunk size must be at least 1, got ${size}`);
    }

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += size) {
        chunks.push(ids.slice(i, i + size));
    }

    return chunks;
}

export function planQueueSync(
    previous: null | readonly string[],
    next: readonly string[],
): QueueSyncPlan {
    const replace: QueueSyncPlan = { ids: [...next], type: 'replace' };

    if (!previous) {
        return replace;
    }

    if (previous.length === next.length && previous.every((id, i) => id === next[i])) {
        return { type: 'none' };
    }

    if (next.length > previous.length && previous.every((id, i) => id === next[i])) {
        return { ids: next.slice(previous.length), type: 'append' };
    }

    if (next.length === previous.length - 1) {
        let index = 0;
        while (index < next.length && previous[index] === next[index]) {
            index++;
        }

        for (let i = index; i < next.length; i++) {
            if (previous[i + 1] !== next[i]) {
                return replace;
            }
        }

        while (index > 0 && previous[index - 1] === previous[index]) {
            index--;
        }

        return { index, type: 'remove' };
    }

    return replace;
}

export function playOrderIds(
    defaultIds: readonly string[],
    shuffled: null | readonly number[],
): string[] {
    if (!shuffled) {
        return [...defaultIds];
    }

    const result: string[] = [];
    for (const index of shuffled) {
        if (Number.isInteger(index) && index >= 0 && index < defaultIds.length) {
            result.push(defaultIds[index]);
        }
    }

    return result;
}

export function queueIndexToServerIndex(
    queueIndex: number,
    shuffled: null | readonly number[],
): null | number {
    if (!shuffled) {
        return Number.isInteger(queueIndex) && queueIndex >= 0 ? queueIndex : null;
    }

    const position = shuffled.indexOf(queueIndex);
    return position === -1 ? null : position;
}

export function serverIndexToQueueIndex(
    serverIndex: number,
    shuffled: null | readonly number[],
): null | number {
    if (!shuffled) {
        return Number.isInteger(serverIndex) && serverIndex >= 0 ? serverIndex : null;
    }

    if (!Number.isInteger(serverIndex) || serverIndex < 0 || serverIndex >= shuffled.length) {
        return null;
    }

    return shuffled[serverIndex];
}
