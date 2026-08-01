/**
 * Small in-process, per-key async mutex.
 *
 * Used by Blitz to serialize its own "check real buying power -> submit order
 * -> await fill" sequence per user, so two Blitz cycles for the same user can
 * never race each other on capital checks. Safe as an in-process (not Redis)
 * lock because workerCoordinationService's leader election already guarantees
 * only one worker process ever runs schedulers at a time — every scheduler,
 * swing and Blitz alike, executes inside that same single process.
 *
 * Bounded wait (not an unbounded queue) so one stuck cycle can't wedge every
 * later cycle for the same user indefinitely — a timeout just proceeds
 * without the lock rather than hanging forever.
 */

const _tails = new Map(); // key -> promise that resolves once that caller is done

async function withUserLock(key, fn, timeoutMs = 8000) {
    const previousTail = _tails.get(key) || Promise.resolve();

    // Bounded wait: proceed once the previous holder finishes (success or
    // failure, doesn't matter which) OR after timeoutMs, whichever is first —
    // a stuck prior call can't wedge every later call for the same user forever.
    const myTurnReady = Promise.race([
        previousTail.then(() => {}, () => {}),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);

    // Register the new tail SYNCHRONOUSLY (before any await) so a caller that
    // arrives while we're still waiting queues behind us, not behind whoever
    // was ahead of us.
    let resolveMyDone;
    const myDone = new Promise(resolve => { resolveMyDone = resolve; });
    _tails.set(key, myDone);

    try {
        await myTurnReady;
        return await fn();
    } finally {
        resolveMyDone();
        if (_tails.get(key) === myDone) _tails.delete(key);
    }
}

module.exports = { withUserLock };
