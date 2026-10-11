import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    chunkIds,
    decideStartup,
    diffServerState,
    planQueueSync,
    planToCalls,
    playOrderIds,
    queueIndexToServerIndex,
    resolveQueueSync,
    serverIndexToQueueIndex,
} from './jukebox-queue.ts';

const make = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

describe('chunkIds', () => {
    it('chunks with the default size', () => {
        assert.deepEqual(chunkIds([]), []);
        assert.deepEqual(
            chunkIds(make(1)).map((c) => c.length),
            [1],
        );
        assert.deepEqual(
            chunkIds(make(50)).map((c) => c.length),
            [50],
        );
        assert.deepEqual(
            chunkIds(make(51)).map((c) => c.length),
            [50, 1],
        );
        assert.deepEqual(
            chunkIds(make(120)).map((c) => c.length),
            [50, 50, 20],
        );
    });

    it('supports a custom size and preserves order', () => {
        assert.deepEqual(chunkIds(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);
    });

    it('throws on size below 1', () => {
        assert.throws(() => chunkIds(['a'], 0), RangeError);
    });
});

describe('playOrderIds', () => {
    it('copies when not shuffled', () => {
        const ids = ['a', 'b'];
        const result = playOrderIds(ids, null);
        assert.deepEqual(result, ids);
        assert.notEqual(result, ids);
    });

    it('reorders by the shuffle', () => {
        assert.deepEqual(playOrderIds(['a', 'b', 'c'], [2, 0, 1]), ['c', 'a', 'b']);
    });

    it('skips invalid indexes', () => {
        assert.deepEqual(playOrderIds(['a', 'b', 'c'], [1, 5, -1, 1.5, 0, Number.NaN]), ['b', 'a']);
    });
});

describe('index mapping', () => {
    it('round trips without a shuffle', () => {
        assert.equal(serverIndexToQueueIndex(3, null), 3);
        assert.equal(queueIndexToServerIndex(3, null), 3);
    });

    it('round trips with a shuffle', () => {
        const shuffled = [2, 0, 1];
        for (let s = 0; s < shuffled.length; s++) {
            const q = serverIndexToQueueIndex(s, shuffled);
            assert.notEqual(q, null);
            assert.equal(queueIndexToServerIndex(q as number, shuffled), s);
        }

        assert.equal(serverIndexToQueueIndex(0, shuffled), 2);
        assert.equal(queueIndexToServerIndex(2, shuffled), 0);
    });

    it('returns null when out of range or negative', () => {
        const shuffled = [2, 0, 1];
        assert.equal(serverIndexToQueueIndex(3, shuffled), null);
        assert.equal(serverIndexToQueueIndex(-1, shuffled), null);
        assert.equal(serverIndexToQueueIndex(-1, null), null);
        assert.equal(queueIndexToServerIndex(5, shuffled), null);
        assert.equal(queueIndexToServerIndex(-1, shuffled), null);
        assert.equal(queueIndexToServerIndex(-1, null), null);
    });
});

describe('planQueueSync', () => {
    it('replaces when previous is null', () => {
        assert.deepEqual(planQueueSync(null, ['a', 'b']), { ids: ['a', 'b'], type: 'replace' });
    });

    it('returns none for identical sequences', () => {
        assert.deepEqual(planQueueSync(['a', 'b'], ['a', 'b']), { type: 'none' });
        assert.deepEqual(planQueueSync([], []), { type: 'none' });
    });

    it('appends', () => {
        assert.deepEqual(planQueueSync(['a'], ['a', 'b']), { ids: ['b'], type: 'append' });
        assert.deepEqual(planQueueSync(['a'], ['a', 'b', 'c', 'd']), {
            ids: ['b', 'c', 'd'],
            type: 'append',
        });
        assert.deepEqual(planQueueSync([], ['a']), { ids: ['a'], type: 'append' });
    });

    it('removes first, middle and last', () => {
        assert.deepEqual(planQueueSync(['a', 'b', 'c'], ['b', 'c']), { index: 0, type: 'remove' });
        assert.deepEqual(planQueueSync(['a', 'b', 'c'], ['a', 'c']), { index: 1, type: 'remove' });
        assert.deepEqual(planQueueSync(['a', 'b', 'c'], ['a', 'b']), { index: 2, type: 'remove' });
    });

    it('removes the first index of a run of duplicates', () => {
        assert.deepEqual(planQueueSync(['a', 'a', 'b'], ['a', 'b']), { index: 0, type: 'remove' });
    });

    it('replaces on reorder', () => {
        assert.deepEqual(planQueueSync(['a', 'b', 'c'], ['c', 'a', 'b']), {
            ids: ['c', 'a', 'b'],
            type: 'replace',
        });
    });

    it('replaces on two removals', () => {
        assert.deepEqual(planQueueSync(['a', 'b', 'c', 'd'], ['a', 'd']), {
            ids: ['a', 'd'],
            type: 'replace',
        });
    });

    it('replaces on append plus a change', () => {
        assert.deepEqual(planQueueSync(['a', 'b'], ['a', 'x', 'c']), {
            ids: ['a', 'x', 'c'],
            type: 'replace',
        });
    });

    it('replaces with an empty list when emptied', () => {
        assert.deepEqual(planQueueSync(['a', 'b'], []), { ids: [], type: 'replace' });
    });
});

describe('diffServerState', () => {
    const seen = { gain: 0.5, index: 2, playing: true };

    it('reports everything changed without a previous state', () => {
        assert.deepEqual(diffServerState(null, seen), { gain: true, index: true, playing: true });
    });

    it('reports no change for an identical state', () => {
        assert.deepEqual(diffServerState(seen, { ...seen }), {
            gain: false,
            index: false,
            playing: false,
        });
    });

    it('ignores a gain difference below 0.01', () => {
        assert.equal(diffServerState(seen, { ...seen, gain: 0.505 }).gain, false);
        assert.equal(diffServerState(seen, { ...seen, gain: 0.495 }).gain, false);
    });

    it('detects a gain difference of 0.01 or more', () => {
        assert.equal(diffServerState(seen, { ...seen, gain: 0.51 }).gain, true);
        assert.equal(diffServerState({ ...seen, gain: 0.2 }, { ...seen, gain: 0.21 }).gain, true);
        assert.equal(diffServerState(seen, { ...seen, gain: 0.3 }).gain, true);
    });

    it('detects index and playing changes independently', () => {
        assert.deepEqual(diffServerState(seen, { ...seen, index: 3 }), {
            gain: false,
            index: true,
            playing: false,
        });
        assert.deepEqual(diffServerState(seen, { ...seen, playing: false }), {
            gain: false,
            index: false,
            playing: true,
        });
    });
});

describe('decideStartup', () => {
    it('adopts when the ids match', () => {
        assert.equal(decideStartup(['a', 'b'], ['a', 'b']), 'adopt');
        assert.equal(decideStartup([], []), 'adopt');
    });

    it('pushes when the ids differ', () => {
        assert.equal(decideStartup(['a', 'b'], ['b', 'a']), 'push');
        assert.equal(decideStartup(['a'], ['a', 'b']), 'push');
        assert.equal(decideStartup(['a', 'b'], ['a']), 'push');
    });

    it('pushes when the server is empty and the local queue is not', () => {
        assert.equal(decideStartup([], ['a']), 'push');
    });

    it('stays idle when the local queue is empty and the server is not', () => {
        assert.equal(decideStartup(['a', 'b'], []), 'idle');
    });

    it('adopts when both are empty', () => {
        assert.equal(decideStartup([], []), 'adopt');
    });
});

describe('planToCalls', () => {
    const ctx = {
        currentServerIndex: 3,
        hadPushedIds: true,
        positionSeconds: 42.9,
        shouldStart: false,
    };

    it('maps none to no calls', () => {
        assert.deepEqual(planToCalls({ type: 'none' }, ctx), []);
    });

    it('maps append to chunked add calls', () => {
        const ids = make(120);
        const calls = planToCalls({ ids, type: 'append' }, ctx);
        assert.deepEqual(
            calls.map((c) => [c.action, c.ids?.length]),
            [
                ['add', 50],
                ['add', 50],
                ['add', 20],
            ],
        );
    });

    it('maps remove to a remove call', () => {
        assert.deepEqual(planToCalls({ index: 4, type: 'remove' }, ctx), [
            { action: 'remove', index: 4 },
        ]);
    });

    it('maps a 120 id replace to set, add, add, skip', () => {
        const ids = make(120);
        const calls = planToCalls({ ids, type: 'replace' }, ctx);
        assert.deepEqual(
            calls.map((c) => c.action),
            ['set', 'add', 'add', 'skip'],
        );
        assert.deepEqual(
            calls.slice(0, 3).map((c) => c.ids?.length),
            [50, 50, 20],
        );
        assert.deepEqual(calls[3], { action: 'skip', index: 3, offset: 42 });
        assert.deepEqual(
            calls.slice(0, 3).flatMap((c) => c.ids ?? []),
            ids,
        );
    });

    it('adds start to a replace only when playing', () => {
        const ids = make(3);
        const playing = planToCalls({ ids, type: 'replace' }, { ...ctx, shouldStart: true });
        assert.equal(playing.at(-1)?.action, 'start');
        const paused = planToCalls({ ids, type: 'replace' }, ctx);
        assert.equal(paused.at(-1)?.action, 'skip');
    });

    it('omits skip when there is no current track', () => {
        const calls = planToCalls(
            { ids: ['a'], type: 'replace' },
            { ...ctx, currentServerIndex: null },
        );
        assert.deepEqual(
            calls.map((c) => c.action),
            ['set'],
        );
    });

    it('maps an empty replace to clear only when ids were pushed before', () => {
        assert.deepEqual(planToCalls({ ids: [], type: 'replace' }, ctx), [{ action: 'clear' }]);
        assert.deepEqual(
            planToCalls({ ids: [], type: 'replace' }, { ...ctx, hadPushedIds: false }),
            [],
        );
    });
});

describe('resolveQueueSync', () => {
    it('keeps a remove of a non-current index', () => {
        assert.deepEqual(resolveQueueSync(['a', 'b', 'c'], ['a', 'c'], 0), {
            index: 1,
            type: 'remove',
        });
    });

    it('turns a remove of the current index into a replace', () => {
        assert.deepEqual(resolveQueueSync(['a', 'b', 'c'], ['a', 'c'], 1), {
            ids: ['a', 'c'],
            type: 'replace',
        });
    });

    it('passes other plans through', () => {
        assert.deepEqual(resolveQueueSync(['a'], ['a', 'b'], 0), { ids: ['b'], type: 'append' });
        assert.deepEqual(resolveQueueSync(['a'], ['a'], null), { type: 'none' });
        assert.deepEqual(resolveQueueSync(['a', 'b'], ['b', 'a'], null), {
            ids: ['b', 'a'],
            type: 'replace',
        });
    });
});
