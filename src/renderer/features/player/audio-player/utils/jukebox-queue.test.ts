import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    chunkIds,
    planQueueSync,
    playOrderIds,
    queueIndexToServerIndex,
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
