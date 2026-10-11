import { useCallback, useRef } from 'react';

import {
    JukeboxPlayerEngine,
    JukeboxPlayerEngineHandle,
    JukeboxServerUpdate,
} from '/@/renderer/features/player/audio-player/engine/jukebox-player-engine';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { serverIndexToQueueIndex } from '/@/renderer/features/player/audio-player/utils/jukebox-queue';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    isShuffleEnabled,
    useCurrentServerId,
    usePlayerActions,
    usePlayerHydrated,
} from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useDebouncedCallback } from '/@/shared/hooks/use-debounced-callback';
import { PlayerStatus } from '/@/shared/types/types';

export function JukeboxPlayer() {
    const playerRef = useRef<JukeboxPlayerEngineHandle>(null);
    const applyingRemoteRef = useRef(false);
    const { mediaPause, mediaPlay, mediaPlayByIndex, setTimestamp, setVolume } = usePlayerActions();
    const player = usePlayer();
    const playerHydrated = usePlayerHydrated();

    const serverId = useCurrentServerId();

    // Store writes made here come from the server; the handlers below must not send them back.
    const handleServerUpdate = useCallback(
        (update: JukeboxServerUpdate) => {
            applyingRemoteRef.current = true;

            try {
                const { changes, gain, index, playing, position } = update;
                const state = usePlayerStoreBase.getState();

                // With no local queue there is no track to show, so only the volume is mirrored.
                if (state.getQueueOrder().items.length === 0) {
                    if (changes.gain) {
                        setVolume(Math.round(gain * 100));
                    }

                    return;
                }

                if (changes.index) {
                    const shuffled = isShuffleEnabled(state) ? state.queue.shuffled : null;
                    const queueIndex = serverIndexToQueueIndex(index, shuffled);
                    const target =
                        queueIndex === null ? undefined : state.getQueueOrder().items[queueIndex];

                    if (target && target._uniqueId !== state.getCurrentSong()?._uniqueId) {
                        mediaPlayByIndex(queueIndex!);
                    }
                }

                // mediaPlayByIndex always starts playback, so re-assert the server's state after it.
                if (changes.index || changes.playing) {
                    if (playing) {
                        mediaPlay();
                    } else if (
                        usePlayerStoreBase.getState().player.status === PlayerStatus.PLAYING ||
                        changes.playing
                    ) {
                        mediaPause();
                    }
                }

                if (position !== null) {
                    setTimestamp(Math.floor(position));
                }

                if (changes.gain) {
                    setVolume(Math.round(gain * 100));
                }
            } finally {
                applyingRemoteRef.current = false;
            }
        },
        [mediaPause, mediaPlay, mediaPlayByIndex, setTimestamp, setVolume],
    );

    const debouncedSeekToTimestamp = useDebouncedCallback((timestamp: number) => {
        playerRef.current?.seekTo(timestamp);
    }, 300);

    const debouncedSetVolume = useDebouncedCallback((nextVolume: number) => {
        playerRef.current?.setVolume(nextVolume);
    }, 300);

    usePlayerEvents(
        {
            onCurrentSongChange: (properties) => {
                if (applyingRemoteRef.current || !properties.song) {
                    return;
                }

                playerRef.current?.trackChanged();
            },
            onPlayerQueueChange: () => {
                playerRef.current?.queueChanged();
            },
            onPlayerSeekToTimestamp: (properties) => {
                if (applyingRemoteRef.current) {
                    return;
                }

                debouncedSeekToTimestamp(properties.timestamp);
            },
            onPlayerShuffle: () => {
                playerRef.current?.queueChanged();
            },
            onPlayerStatus: (properties) => {
                if (applyingRemoteRef.current) {
                    return;
                }

                if (properties.status === PlayerStatus.PLAYING) {
                    playerRef.current?.play();
                } else {
                    playerRef.current?.pause();
                }
            },
            onPlayerVolume: (properties) => {
                if (applyingRemoteRef.current) {
                    return;
                }

                debouncedSetVolume(properties.volume);
            },
            onQueueCleared: () => {
                player.mediaStop();
            },
        },
        [debouncedSeekToTimestamp, debouncedSetVolume, player],
    );

    return (
        <JukeboxPlayerEngine
            enabled={playerHydrated && Boolean(serverId)}
            onServerUpdate={handleServerUpdate}
            playerRef={playerRef}
            serverId={serverId}
        />
    );
}
