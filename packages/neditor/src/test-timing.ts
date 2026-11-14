/**
 * Growth tests: is this work linear in its input?
 *
 * Timed as a ratio between two sizes rather than against a budget: a budget is
 * a statement about the machine, and the absolute version of such a test
 * failed on an unmodified tree while passing on code that was still quadratic.
 * Test-only; nothing in the package imports it.
 */

/**
 * How much longer sixteen times the input may take: about 16x for linear work,
 * about 256x for quadratic. The line is drawn wide between them, because
 * allocation makes honest linear work come out at 30x or so at these sizes, and
 * more when the whole suite is running beside it.
 */
export const LINEAR = 90;

/**
 * How long a sample must last before its time means anything. A timer reads in
 * steps of a fraction of a millisecond, and a call that takes less than a step
 * read as zero -- so the old helper clamped the small size to 1 ms, which made
 * every fast test a 90 ms budget on the large size, and cheap quadratic work
 * (66 ms at the large size) passed it.
 */
const SAMPLE_MS = 5;

/** How long `growthOf` measures before settling for its best reading. */
const BUDGET_MS = 20_000;

/**
 * Milliseconds one call of `work` takes: repeated until a sample is long
 * enough, best of three samples. A single call that is already long enough
 * counts as the first sample, so slow work runs three times, not four.
 */
export function perCall(work: () => void): number {
  let repeats = 1;
  let first = Infinity;

  for (;;) {
    const began = performance.now();

    for (let call = 0; call < repeats; call += 1) {
      work();
    }

    const took = performance.now() - began;

    if (took >= SAMPLE_MS || repeats >= 1 << 16) {
      first = took / repeats;
      break;
    }

    repeats *= 2;
  }

  let best = first;

  for (let sample = 1; sample < 3; sample += 1) {
    const began = performance.now();

    for (let call = 0; call < repeats; call += 1) {
      work();
    }

    best = Math.min(best, (performance.now() - began) / repeats);
  }

  return best;
}

/**
 * The ratio of one call at `size * 16` to one at `size`, where `prepare(size)`
 * sets the input up and returns the work to time; quadratic work is about
 * 256x. Load on the machine, and a collection of the large run's garbage
 * landing in the next small one, only ever add time to a sample -- so each
 * size keeps the fastest it was ever measured at, and the ratio is of those.
 * The lowest *ratio* is no honest reading: a slow small sample makes it low,
 * and a writer made quadratic by an `indexOf` per run, over 110x when
 * measured this way, read 46-76x and passed. Cheap quadratic work only shows
 * at sizes where its square outweighs the linear part: size a test so a large
 * call takes a few hundred milliseconds. At most four rounds -- one when
 * clearly under `limit` -- and no more once twenty seconds have gone, when
 * the best reading so far is the answer.
 */
export function growthOf(
  prepare: (size: number) => () => void,
  size: number,
  limit = LINEAR,
): number {
  let small = Infinity;
  let large = Infinity;
  const began = performance.now();

  // Unmeasured: the first calls run before the engine has compiled the work,
  // and a cold small sample made a quadratic writer read as linear.
  perCall(prepare(size));

  for (let round = 0; round < 4; round += 1) {
    small = Math.min(small, perCall(prepare(size)));
    large = Math.min(large, perCall(prepare(size * 16)));

    // Under half the limit at once is linear past doubt, and the largest
    // sizes take seconds a call; anything closer is measured again.
    // Past twenty seconds, what has been measured is the answer: the
    // largest inputs take seconds a call on a loaded machine, and more rounds
    // ran the test into its timeout on code that was linear all along.
    if (
      large / small < (round === 0 ? limit / 2 : limit) ||
      performance.now() - began > BUDGET_MS
    ) {
      break;
    }
  }

  return large / small;
}

/** {@link growthOf} for work that sets up its own input. */
export function growth(work: (size: number) => void, size: number, limit = LINEAR): number {
  return growthOf((n) => () => work(n), size, limit);
}
