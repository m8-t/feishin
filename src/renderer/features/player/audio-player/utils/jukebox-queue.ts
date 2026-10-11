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

export const GAIN_EPSILON = 0.01;
export const SEEK_ECHO_WINDOW_MS = 400;

export type JukeboxCall = {
    action: 'add' | 'clear' | 'remove' | 'set' | 'setGain' | 'setMute' | 'skip' | 'start' | 'stop';
    gain?: number;
    ids?: string[];
    index?: number;
    mute?: boolean;
    offset?: number;
};

export type JukeboxSeenState = {
    gain: number;
    index: number;
    muted?: boolean;
    playing: boolean;
};

export type PlanCallsContext = {
    currentServerIndex: null | number;
    hadPushedIds: boolean;
    positionSeconds: number;
    shouldStart: boolean;
};

export type ServerStateChanges = {
    gain: boolean;
    index: boolean;
    muted: boolean;
    playing: boolean;
};

export function decideStartup(
    serverIds: readonly string[],
    localIds: readonly string[],
): 'adopt' | 'push' | 'take' {
    const equal =
        serverIds.length === localIds.length && serverIds.every((id, i) => id === localIds[i]);

    if (equal) {
        return 'adopt';
    }

    return serverIds.length > 0 ? 'take' : 'push';
}

export function serverQueueChanged(
    lastPushed: null | readonly string[],
    serverIds: readonly string[],
): boolean {
    if (lastPushed === null) {
        return false;
    }

    return (
        lastPushed.length !== serverIds.length || lastPushed.some((id, i) => id !== serverIds[i])
    );
}

// normalizeSong dereferences contentType without a null check (contentType.startsWith);
// id and title are required by the song schema and used as queue identity and display name.
export function isCompleteSongEntry(entry: unknown): boolean {
    if (entry === null || typeof entry !== 'object') {
        return false;
    }

    const record = entry as Record<string, unknown>;
    return (
        typeof record.id === 'string' &&
        typeof record.title === 'string' &&
        typeof record.contentType === 'string'
    );
}

export function diffServerState(
    lastSeen: JukeboxSeenState | null,
    incoming: JukeboxSeenState,
): ServerStateChanges {
    if (!lastSeen) {
        return { gain: true, index: true, muted: incoming.muted !== undefined, playing: true };
    }

    return {
        gain: Math.abs(incoming.gain - lastSeen.gain) >= GAIN_EPSILON - 1e-9,
        index: incoming.index !== lastSeen.index,
        muted: incoming.muted !== undefined && incoming.muted !== lastSeen.muted,
        playing: incoming.playing !== lastSeen.playing,
    };
}

// The startup timestamp restore seeks about 100 ms after a play status change. A person
// cannot seek that fast, so a seek right after a status event is not a user action.
export function isSeekEcho(
    msSinceStatusEvent: null | number,
    windowMs: number = SEEK_ECHO_WINDOW_MS,
): boolean {
    return msSinceStatusEvent !== null && msSinceStatusEvent >= 0 && msSinceStatusEvent < windowMs;
}

export const SONG_CHANGE_SEEK_WINDOW_MS = 400;

// Feishin resets its seek position to 0 on every song change. In jukebox mode the track
// change itself already starts the track at 0, so that reset must not be sent as a seek.
export function isSongChangeSeekReset(
    timestamp: number,
    seekEventAt: number,
    lastSongChangeAt: null | number,
    windowMs: number = SONG_CHANGE_SEEK_WINDOW_MS,
): boolean {
    return (
        timestamp === 0 &&
        lastSongChangeAt !== null &&
        Math.abs(seekEventAt - lastSongChangeAt) < windowMs
    );
}

export function planToCalls(plan: QueueSyncPlan, context: PlanCallsContext): JukeboxCall[] {
    switch (plan.type) {
        case 'append':
            return chunkIds(plan.ids).map((ids) => ({ action: 'add', ids }));
        case 'none':
            return [];
        case 'remove':
            return [{ action: 'remove', index: plan.index }];
        case 'replace': {
            if (plan.ids.length === 0) {
                return context.hadPushedIds ? [{ action: 'clear' }] : [];
            }

            const [first, ...rest] = chunkIds(plan.ids);
            const calls: JukeboxCall[] = [{ action: 'set', ids: first }];
            for (const ids of rest) {
                calls.push({ action: 'add', ids });
            }

            if (context.currentServerIndex !== null) {
                calls.push({
                    action: 'skip',
                    index: context.currentServerIndex,
                    offset: Math.max(0, Math.floor(context.positionSeconds)),
                });
            }

            if (context.shouldStart) {
                calls.push({ action: 'start' });
            }

            return calls;
        }
    }
}

export function resolveQueueSync(
    previous: null | readonly string[],
    next: readonly string[],
    serverCurrentIndex: null | number,
): QueueSyncPlan {
    const plan = planQueueSync(previous, next);

    if (plan.type === 'remove' && plan.index === serverCurrentIndex) {
        return { ids: [...next], type: 'replace' };
    }

    return plan;
}

export function shouldSendGain(gain: number, lastSeen: JukeboxSeenState | null): boolean {
    return !lastSeen || Math.abs(gain - lastSeen.gain) >= GAIN_EPSILON - 1e-9;
}

export function shouldSendMute(muted: boolean, lastSeen: JukeboxSeenState | null): boolean {
    return !lastSeen || lastSeen.muted !== muted;
}

export function shouldSendPlayState(playing: boolean, lastSeen: JukeboxSeenState | null): boolean {
    return !lastSeen || lastSeen.playing !== playing;
}

// A store event that only restates what the server already reported is an echo, however
// late it arrives, so these compare values instead of relying on a flag that has been cleared.
export function shouldSendTrackChange(
    serverIndex: null | number,
    lastSeen: JukeboxSeenState | null,
): boolean {
    return serverIndex !== null && (!lastSeen || lastSeen.index !== serverIndex);
}
