/** Synthesized cues through Web Audio; no asset files. Muted state persists per browser. */
let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem('muted') === '1';
} catch {
  // storage blocked; stay unmuted
}

/**
 * Create or resume the context. Browsers only allow this from a user gesture, and
 * resume() is asynchronous, so the first cue right after it may still be silent;
 * every later gesture calls this again. A context that exists is kept even when a
 * resume is rejected — only a failed constructor leaves us without one.
 */
export function unlock(): void {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
      return;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('muted', m ? '1' : '0');
  } catch {
    // ignore
  }
}

/** One sine note: `freq` Hz for `ms`, with a soft attack and release. */
function note(freq: number, ms: number, startIn = 0, gain = 0.08): void {
  if (muted || !ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + startIn / 1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0005, t0 + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

/** Phase change: two rising notes. */
export function chime(): void {
  note(523, 140);
  note(784, 220, 120);
}

/** Your turn: one bright note. */
export function ding(): void {
  note(988, 260, 0, 0.1);
}

/** Last seconds: a dry tick. */
export function tickSound(): void {
  note(1320, 45, 0, 0.05);
}

/** New line in the chat: a soft tap. */
export function tap(): void {
  note(440, 60, 0, 0.04);
}
