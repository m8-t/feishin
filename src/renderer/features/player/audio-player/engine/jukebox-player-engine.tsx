import type { RefObject } from 'react';

import { useEffect, useImperativeHandle, useRef } from 'react';

import { useJukeboxControl } from '/@/renderer/features/player/audio-player/hooks/use-jukebox-control';
import { AudioPlayer } from '/@/renderer/features/player/audio-player/types';
import {
    decideStartup,
    diffServerState,
    JukeboxCall,
    JukeboxSeenState,
    planToCalls,
    playOrderIds,
    queueIndexToServerIndex,
    resolveQueueSync,
    ServerStateChanges,
} from '/@/renderer/features/player/audio-player/utils/jukebox-queue';
import {
    isShuffleEnabled,
    mapShuffledToQueueIndex,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { logger } from '/@/renderer/utils/logger';
import { JukeboxControlAction, JukeboxControlResponse } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';

export interface JukeboxPlayerEngineHandle extends AudioPlayer {
    queueChanged(): void;
    setMuted(muted: boolean): void;
    trackChanged(): void;
}

export type JukeboxServerUpdate = {
    changes: ServerStateChanges;
    gain: number;
    index: number;
    muted?: boolean;
    playing: boolean;
    position: null | number;
};

interface JukeboxPlayerEngineProps {
    enabled: boolean;
    onServerUpdate: (update: JukeboxServerUpdate) => void;
    playerRef: RefObject<JukeboxPlayerEngineHandle | null>;
    serverId: string;
}

type Snapshot = {
    currentServerIndex: null | number;
    orderIds: string[];
    status: PlayerStatus;
    timestamp: number;
};

const POLL_INTERVAL_MS = 1000;
const QUEUE_SYNC_DEBOUNCE_MS = 500;
const COMMAND_HOLD_MS = 300;

const readSnapshot = (): Snapshot => {
    const state = usePlayerStoreBase.getState();
    const items = state.getQueueOrder().items;
    const shuffled = isShuffleEnabled(state) ? state.queue.shuffled : null;
    const orderIds = playOrderIds(
        items.map((item) => item.id),
        shuffled,
    );

    const queueIndex = shuffled
        ? mapShuffledToQueueIndex(state.player.index, shuffled)
        : state.player.index;
    const hasCurrent = queueIndex >= 0 && queueIndex < items.length;

    return {
        currentServerIndex: hasCurrent ? queueIndexToServerIndex(queueIndex, shuffled) : null,
        orderIds,
        status: state.player.status,
        timestamp: useTimestampStoreBase.getState().timestamp,
    };
};

export const JukeboxPlayerEngine = (props: JukeboxPlayerEngineProps) => {
    const { enabled, onServerUpdate, playerRef, serverId } = props;

    const jukeboxControlMutation = useJukeboxControl();

    const callApi = async (
        action: JukeboxControlAction,
        queryParams: {
            gain?: number;
            id?: string | string[];
            index?: number;
            mute?: boolean;
            offset?: number;
        } = {},
    ): Promise<JukeboxControlResponse> => {
        try {
            return await jukeboxControlMutation.mutateAsync({
                apiClientProps: { serverId },
                query: { action, ...queryParams },
            });
        } catch (error) {
            logger.warn('Jukebox request failed', { action, error: String(error) });
            return null;
        }
    };

    const callApiRef = useRef(callApi);
    callApiRef.current = callApi;
    const onServerUpdateRef = useRef(onServerUpdate);
    onServerUpdateRef.current = onServerUpdate;

    const epochRef = useRef(0);
    const readyRef = useRef(false);
    const lastSeenRef = useRef<JukeboxSeenState | null>(null);
    const lastPushedRef = useRef<null | string[]>(null);
    const pendingRef = useRef(0);
    const generationRef = useRef(0);
    const holdUntilRef = useRef(0);
    const chainRef = useRef<Promise<void>>(Promise.resolve());
    const syncTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    const tickBusyRef = useRef(false);
    // Decided by the first reply of a session: servers without the extension never get setMute.
    const muteSupportRef = useRef<'absent' | 'present' | 'unknown'>('unknown');

    const noteMuteSupport = (muted: boolean | undefined) => {
        if (muteSupportRef.current === 'unknown') {
            muteSupportRef.current = typeof muted === 'boolean' ? 'present' : 'absent';
            logger.info('Jukebox mute support', { support: muteSupportRef.current });
        }
    };

    // Commands run strictly one after another so a poll never reads a half-applied queue.
    const enqueue = (job: () => Promise<void>): Promise<void> => {
        pendingRef.current++;
        generationRef.current++;

        const run = chainRef.current.then(async () => {
            try {
                await job();
            } catch (error) {
                logger.error('Jukebox command failed', { error: String(error) });
            } finally {
                pendingRef.current--;
                generationRef.current++;
                holdUntilRef.current = Date.now() + COMMAND_HOLD_MS;
            }
        });

        chainRef.current = run;
        return run;
    };

    // After a failed call the server state is unknown: forget what we assumed so the
    // next poll adopts the server's truth and the next queue sync does a full replace.
    const sendCalls = async (calls: JukeboxCall[]): Promise<boolean> => {
        for (const call of calls) {
            logger.info('Jukebox command sent', {
                action: call.action,
                gain: call.gain,
                ids: call.ids?.length ?? 0,
                index: call.index,
                mute: call.mute,
                offset: call.offset,
            });
            const res = await callApiRef.current(call.action, {
                gain: call.gain,
                id: call.ids,
                index: call.index,
                mute: call.mute,
                offset: call.offset,
            });

            if (res === null) {
                lastSeenRef.current = null;
                lastPushedRef.current = null;
                return false;
            }
        }

        return true;
    };

    const patchLastSeen = (patch: Partial<JukeboxSeenState>) => {
        if (lastSeenRef.current) {
            lastSeenRef.current = { ...lastSeenRef.current, ...patch };
        }
    };

    const syncQueue = async (forceSkip: boolean) => {
        if (!readyRef.current) {
            return;
        }

        const snapshot = readSnapshot();
        const plan = resolveQueueSync(
            lastPushedRef.current,
            snapshot.orderIds,
            lastSeenRef.current?.index ?? null,
        );
        const shouldStart = snapshot.status === PlayerStatus.PLAYING;
        const calls = planToCalls(plan, {
            currentServerIndex: snapshot.currentServerIndex,
            hadPushedIds: (lastPushedRef.current?.length ?? 0) > 0,
            positionSeconds: snapshot.timestamp,
            shouldStart,
        });

        const skipToCurrent =
            plan.type !== 'replace' &&
            forceSkip &&
            snapshot.currentServerIndex !== null &&
            snapshot.orderIds.length > 0;

        if (skipToCurrent) {
            calls.push({ action: 'skip', index: snapshot.currentServerIndex!, offset: 0 });
        }

        if (calls.length === 0) {
            return;
        }

        if (!(await sendCalls(calls))) {
            return;
        }

        lastPushedRef.current = snapshot.orderIds;

        if (plan.type === 'replace') {
            patchLastSeen({ index: snapshot.currentServerIndex ?? 0, playing: shouldStart });
        } else if (
            plan.type === 'remove' &&
            lastSeenRef.current &&
            plan.index < lastSeenRef.current.index
        ) {
            patchLastSeen({ index: lastSeenRef.current.index - 1 });
        }

        if (skipToCurrent) {
            patchLastSeen({ index: snapshot.currentServerIndex! });
        }
    };

    const scheduleQueueSync = () => {
        if (!readyRef.current) {
            logger.warn('Jukebox queue sync skipped: engine not ready');
            return;
        }

        if (syncTimerRef.current) {
            clearTimeout(syncTimerRef.current);
        }

        syncTimerRef.current = setTimeout(() => {
            syncTimerRef.current = null;
            void enqueue(() => syncQueue(false));
        }, QUEUE_SYNC_DEBOUNCE_MS);
    };

    const initialize = async (epoch: number) => {
        const res = await callApiRef.current('get');
        if (epoch !== epochRef.current) {
            return;
        }

        if (res === null) {
            logger.warn('Jukebox startup get returned nothing, retrying');
            return;
        }

        const playlist = res.jukeboxPlaylist;
        noteMuteSupport(playlist?.muted);
        const serverIds = playlist?.entry?.map((entry) => entry.id) ?? [];
        const snapshot = readSnapshot();

        const decision = decideStartup(serverIds, snapshot.orderIds);
        logger.info('Jukebox startup decision', {
            decision,
            localTracks: snapshot.orderIds.length,
            serverTracks: serverIds.length,
        });

        if (decision === 'idle' && playlist) {
            // Nothing local to show: leave the device alone and only take over its volume.
            const seen: JukeboxSeenState = {
                gain: playlist.gain,
                index: playlist.currentIndex ?? 0,
                muted: playlist.muted,
                playing: playlist.playing,
            };
            lastPushedRef.current = null;
            lastSeenRef.current = seen;
            onServerUpdateRef.current({
                ...seen,
                changes: {
                    gain: true,
                    index: false,
                    muted: seen.muted !== undefined,
                    playing: false,
                },
                position: null,
            });
        } else if (decision === 'adopt' && playlist) {
            const seen: JukeboxSeenState = {
                gain: playlist.gain,
                index: playlist.currentIndex ?? 0,
                muted: playlist.muted,
                playing: playlist.playing,
            };
            lastPushedRef.current = serverIds;
            lastSeenRef.current = seen;
            onServerUpdateRef.current({
                ...seen,
                changes: diffServerState(null, seen),
                position: playlist.position ?? null,
            });
        } else {
            // The server stays stopped until the user presses play; only its volume is taken over.
            const ok = await enqueue(async () => {
                const calls = planToCalls(
                    { ids: snapshot.orderIds, type: 'replace' },
                    {
                        currentServerIndex: snapshot.currentServerIndex,
                        hadPushedIds: false,
                        positionSeconds: snapshot.timestamp,
                        shouldStart: false,
                    },
                );

                if (epoch !== epochRef.current || !(await sendCalls(calls))) {
                    return;
                }

                lastPushedRef.current = snapshot.orderIds;
                const gain = playlist?.gain;
                const seen: JukeboxSeenState = {
                    gain: gain ?? 0,
                    index: snapshot.currentServerIndex ?? 0,
                    muted: playlist?.muted,
                    playing: false,
                };
                lastSeenRef.current = gain === undefined ? null : seen;

                if (gain !== undefined) {
                    onServerUpdateRef.current({
                        changes: {
                            gain: true,
                            index: false,
                            muted: seen.muted !== undefined,
                            playing: snapshot.status === PlayerStatus.PLAYING,
                        },
                        gain,
                        index: seen.index,
                        muted: seen.muted,
                        playing: false,
                        position: null,
                    });
                }
            }).then(() => lastPushedRef.current !== null);

            if (!ok) {
                return;
            }
        }

        if (epoch !== epochRef.current) {
            return;
        }

        readyRef.current = true;
        scheduleQueueSync();
    };

    const pollOnce = async (epoch: number) => {
        const generation = generationRef.current;
        const res = await callApiRef.current('get');
        const playlist = res?.jukeboxPlaylist;

        if (
            epoch !== epochRef.current ||
            generation !== generationRef.current ||
            pendingRef.current > 0 ||
            !playlist
        ) {
            return;
        }

        if (lastPushedRef.current === null && readSnapshot().orderIds.length > 0) {
            scheduleQueueSync();
        }

        noteMuteSupport(playlist.muted);

        const incoming: JukeboxSeenState = {
            gain: playlist.gain,
            index: playlist.currentIndex ?? 0,
            muted: playlist.muted,
            playing: playlist.playing,
        };
        const changes = diffServerState(lastSeenRef.current, incoming);

        lastSeenRef.current = {
            ...incoming,
            gain: changes.gain || !lastSeenRef.current ? incoming.gain : lastSeenRef.current.gain,
            muted: incoming.muted ?? lastSeenRef.current?.muted,
        };

        onServerUpdateRef.current({ ...incoming, changes, position: playlist.position ?? null });
    };

    const tick = async () => {
        if (tickBusyRef.current || pendingRef.current > 0) {
            return;
        }

        const epoch = epochRef.current;
        tickBusyRef.current = true;

        try {
            if (!readyRef.current) {
                await initialize(epoch);
            } else if (Date.now() >= holdUntilRef.current) {
                await pollOnce(epoch);
            }
        } finally {
            tickBusyRef.current = false;
        }
    };

    const tickRef = useRef(tick);
    tickRef.current = tick;

    const resetRef = useRef(() => {});
    resetRef.current = () => {
        epochRef.current++;
        readyRef.current = false;
        lastSeenRef.current = null;
        lastPushedRef.current = null;
        muteSupportRef.current = 'unknown';

        if (syncTimerRef.current) {
            clearTimeout(syncTimerRef.current);
            syncTimerRef.current = null;
        }
    };

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const reset = resetRef.current;
        reset();
        logger.info('Jukebox engine enabled', { serverId });

        void tickRef.current();
        const interval = setInterval(() => void tickRef.current(), POLL_INTERVAL_MS);

        return () => {
            clearInterval(interval);
            reset();
        };
    }, [enabled, serverId]);

    const command = (calls: () => JukeboxCall[], onSent?: () => void) => {
        if (!readyRef.current) {
            logger.warn('Jukebox command skipped: engine not ready');
            return;
        }

        const epoch = epochRef.current;
        void enqueue(async () => {
            if (epoch !== epochRef.current) {
                return;
            }

            if (await sendCalls(calls())) {
                onSent?.();
            }
        });
    };

    useImperativeHandle<JukeboxPlayerEngineHandle, JukeboxPlayerEngineHandle>(playerRef, () => ({
        decreaseVolume(by: number) {
            this.setVolume(usePlayerStoreBase.getState().player.volume - by);
        },
        increaseVolume(by: number) {
            this.setVolume(usePlayerStoreBase.getState().player.volume + by);
        },
        pause() {
            command(
                () => [{ action: 'stop' }],
                () => patchLastSeen({ playing: false }),
            );
        },
        play() {
            command(
                () => [{ action: 'start' }],
                () => patchLastSeen({ playing: true }),
            );
        },
        queueChanged() {
            scheduleQueueSync();
        },
        seekTo(seconds: number) {
            const index = readSnapshot().currentServerIndex;
            if (index === null) {
                return;
            }

            command(
                () => [{ action: 'skip', index, offset: Math.max(0, Math.floor(seconds)) }],
                () => patchLastSeen({ index }),
            );
        },
        setMuted(muted: boolean) {
            if (muteSupportRef.current !== 'present') {
                logger.debug('Jukebox mute not forwarded: server has no mute support');
                return;
            }

            command(
                () => [{ action: 'setMute', mute: muted }],
                () => patchLastSeen({ muted }),
            );
        },
        setVolume(vol: number) {
            const gain = Math.min(1, Math.max(0, vol / 100));
            command(
                () => [{ action: 'setGain', gain }],
                () => patchLastSeen({ gain }),
            );
        },
        trackChanged() {
            if (!readyRef.current) {
                logger.warn('Jukebox track change skipped: engine not ready');
                return;
            }

            // Flush any pending queue edit first so the skip index refers to the pushed order.
            if (syncTimerRef.current) {
                clearTimeout(syncTimerRef.current);
                syncTimerRef.current = null;
            }

            const epoch = epochRef.current;
            void enqueue(async () => {
                if (epoch === epochRef.current) {
                    await syncQueue(true);
                }
            });
        },
    }));

    return <div id="jukebox-player-engine" style={{ display: 'none' }} />;
};

JukeboxPlayerEngine.displayName = 'JukeboxPlayerEngine';
