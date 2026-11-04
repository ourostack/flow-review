// A small frame meter for the engine tests, on the basics gate's input-to-motion and dead-input definitions: each
// frame (requestAnimationFrame, its timestamp the frame's start) records the scroller's scrollTop, and each wheel its
// event timeStamp and deltaY, in capture. Both clocks are performance.now()'s, on every engine. analyze() is pure (it
// runs in Node too): per wheel, the time from its timeStamp to the start of the first frame whose scrollTop moved its
// way; a wheel that moved nothing for 100 ms or more, away from the edges, is dead input. It stands in for the gate's
// own meter, which flow-review takes in later; the engine tests only need one that runs the same way everywhere.
(() => {
  const DEAD_MS = 100;
  function analyze(frames, inputs) {
    const motion = [];
    for (const w of inputs.filter((x) => x.dy)) {
      const dir = Math.sign(w.dy);
      const i0 = frames.findIndex((f) => f.t >= w.ts);
      if (i0 < 0) continue;
      const before = frames[i0 - 1] ?? frames[i0];
      if ((dir < 0 && before.st <= 0.5) || (dir > 0 && before.st >= before.max - 0.5)) continue;
      let moved = null;
      for (let k = i0; k < frames.length; k++) {
        const prev = frames[k - 1] ?? before;
        if (Math.sign(frames[k].st - prev.st) === dir && Math.abs(frames[k].st - prev.st) >= 0.5) { moved = k; break; }
      }
      const ms = (moved === null ? frames.at(-1).t : frames[moved].t) - w.ts;
      motion.push({ ms: Math.max(0, ms), frames: moved === null ? null : moved - i0 + 1, moved: moved !== null });
    }
    const dead = motion.filter((m) => !m.moved || m.ms >= DEAD_MS);
    return { inputs: motion.length, maxMs: motion.length ? Math.max(...motion.map((m) => m.ms)) : null, deadInput: dead.length, motion };
  }
  if (typeof window === 'undefined') return void (globalThis.testMeter = { analyze });
  const frames = [];
  const inputs = [];
  let scroller = null;
  addEventListener('wheel', (e) => { if (scroller) inputs.push({ ts: e.timeStamp, seen: performance.now(), dy: e.deltaY }); }, { capture: true, passive: true });
  const tick = (t) => {
    if (!scroller) return;
    frames.push({ t, st: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight });
    if (frames.length < 20000) requestAnimationFrame(tick);
  };
  window.__testMeter = {
    start(selector) { scroller = document.querySelector(selector); frames.length = 0; inputs.length = 0; requestAnimationFrame(tick); },
    stop() { const out = { frames: [...frames], inputs: [...inputs], now: performance.now() }; scroller = null; return out; },
    analyze,
  };
})();
