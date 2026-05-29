/**
 * Shared AWS error / async helpers.
 *
 * Consolidates idioms that were copy-pasted across the tool Lambdas:
 *   - matching an AWS SDK error by name (was
 *     `/X/.test(String(e?.name) + String(e?.message))` in ~8 places)
 *   - the `sleep` helper (was redefined in 3 handlers)
 *   - the fire-and-poll-short loop (used in deploy_ecs + configure_merchant)
 */

/**
 * True if the AWS SDK error matches any of the given name/message patterns.
 * Equivalent to the previous inline regex test against name + message.
 */
function isAwsError(e, ...patterns) {
  const hay = `${e?.name || ''} ${e?.message || ''}`;
  return patterns.some((p) => hay.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `probe()` every `intervalMs` until it reports done or `budgetMs` elapses.
 * `probe` returns `{ done, value }`. Transient errors are logged at debug and
 * the loop continues — replacing the silent `catch (_) {}` blocks.
 * Returns the last observed `value` (may be undefined if nothing was seen).
 */
async function pollUntil(probe, { budgetMs, intervalMs, label = 'poll' }) {
  const start = Date.now();
  let last;
  while (Date.now() - start < budgetMs) {
    await sleep(intervalMs);
    try {
      const { done, value } = await probe();
      last = value;
      if (done) return value;
    } catch (e) {
      console.debug(label, 'transient error:', e?.name || e?.message);
    }
  }
  return last;
}

module.exports = { isAwsError, sleep, pollUntil };
