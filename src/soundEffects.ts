/**
 * Procedural Web Audio VFX Sound Engine for Stark Mark LXXXV Nanotech Suit.
 * Zero external assets — synthesizes Arc Reactor ignition, cascading liquid-metal
 * nanite crystallization chimes, faceplate servo lock, retraction sweep, and repulsor blast.
 */

class StarkSoundEngine {
  private ctx: AudioContext | null = null;
  private enabled = true;

  setEnabled(value: boolean) {
    this.enabled = value;
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled || typeof window === 'undefined') return null;
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      if (this.ctx.state !== 'running') return null;
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Plays the Infinity War / Endgame nanotech suit-up liquid-metal cascade + faceplate lock. */
  playSuitUp(durationMs = 3400) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = Math.max(1.2, Math.min(durationMs / 1000, 7.0));
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.18, now);
    master.connect(ctx.destination);

    // 1. Chest Arc Reactor ignition pulse + rising turbine whine
    const reactorSub = ctx.createOscillator();
    const subGain = ctx.createGain();
    reactorSub.type = 'sine';
    reactorSub.frequency.setValueAtTime(58, now);
    reactorSub.frequency.exponentialRampToValueAtTime(118, now + 0.35);
    reactorSub.frequency.exponentialRampToValueAtTime(76, now + dur * 0.85);
    subGain.gain.setValueAtTime(0.001, now);
    subGain.gain.linearRampToValueAtTime(0.55, now + 0.08);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.92);
    reactorSub.connect(subGain).connect(master);
    reactorSub.start(now);
    reactorSub.stop(now + dur);

    const turbine = ctx.createOscillator();
    const turbineGain = ctx.createGain();
    turbine.type = 'triangle';
    turbine.frequency.setValueAtTime(340, now);
    turbine.frequency.exponentialRampToValueAtTime(1680, now + dur * 0.82);
    turbineGain.gain.setValueAtTime(0.001, now);
    turbineGain.gain.linearRampToValueAtTime(0.14, now + 0.25);
    turbineGain.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.95);
    turbine.connect(turbineGain).connect(master);
    turbine.start(now);
    turbine.stop(now + dur);

    // 2. Cascading metallic liquid-nanite micro-crystallization grains
    const grainCount = 22;
    for (let i = 0; i < grainCount; i++) {
      const progress = i / grainCount;
      const t = now + 0.1 + progress * dur * 0.76;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      const baseFreq = 1150 + progress * 1950 + ((i * 397) % 520);
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.28, t + 0.065);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
      osc.connect(gain).connect(master);
      osc.start(t);
      osc.stop(t + 0.095);
    }

    // 3. Final Mark 85 helmet faceplate metallic clink-lock + eye power-on
    const lockTime = now + dur * 0.84;
    this.scheduleMetallicLock(ctx, master, lockTime, true);
  }

  /** Plays smooth reverse nanotech dissolution back into the chest Arc Reactor pod. */
  playSuitRetract(durationMs = 2400) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const dur = Math.max(1.0, Math.min(durationMs / 1000, 5.0));
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.15, now);
    master.connect(ctx.destination);

    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweep.type = 'triangle';
    sweep.frequency.setValueAtTime(1520, now);
    sweep.frequency.exponentialRampToValueAtTime(220, now + dur * 0.88);
    sweepGain.gain.setValueAtTime(0.001, now);
    sweepGain.gain.linearRampToValueAtTime(0.22, now + 0.08);
    sweepGain.gain.exponentialRampToValueAtTime(0.001, now + dur * 0.92);
    sweep.connect(sweepGain).connect(master);
    sweep.start(now);
    sweep.stop(now + dur);

    for (let i = 0; i < 14; i++) {
      const p = i / 14;
      const t = now + p * dur * 0.72;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      const freq = 2800 - p * 1700 + ((i * 251) % 320);
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.78, t + 0.06);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.075, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.08);
    }
  }

  /** Plays crisp Mark 85 faceplate visor open / close nano-servo sound. */
  playVisorToggle(closing: boolean) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.16, now);
    master.connect(ctx.destination);
    this.scheduleMetallicLock(ctx, master, now, closing);
  }

  /** Plays iconic Iron Man palm repulsor whine + plasma blast! */
  playRepulsorBlast() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.18, now);
    master.connect(ctx.destination);

    // Rapid capacitor whine
    const whine = ctx.createOscillator();
    const whineGain = ctx.createGain();
    whine.type = 'sawtooth';
    whine.frequency.setValueAtTime(620, now);
    whine.frequency.exponentialRampToValueAtTime(2900, now + 0.09);
    whine.frequency.exponentialRampToValueAtTime(980, now + 0.34);
    whineGain.gain.setValueAtTime(0.001, now);
    whineGain.gain.linearRampToValueAtTime(0.14, now + 0.05);
    whineGain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.Q.setValueAtTime(2.5, now);
    whine.connect(filter).connect(whineGain).connect(master);
    whine.start(now);
    whine.stop(now + 0.38);

    // Punchy plasma impact thump
    const punch = ctx.createOscillator();
    const punchGain = ctx.createGain();
    punch.type = 'sine';
    punch.frequency.setValueAtTime(190, now + 0.03);
    punch.frequency.exponentialRampToValueAtTime(42, now + 0.34);
    punchGain.gain.setValueAtTime(0.001, now + 0.03);
    punchGain.gain.linearRampToValueAtTime(0.65, now + 0.045);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
    punch.connect(punchGain).connect(master);
    punch.start(now + 0.03);
    punch.stop(now + 0.38);
  }

  private scheduleMetallicLock(ctx: AudioContext, dest: AudioNode, t: number, closing: boolean) {
    const servo = ctx.createOscillator();
    const servoGain = ctx.createGain();
    servo.type = 'sine';
    servo.frequency.setValueAtTime(closing ? 780 : 1950, t);
    servo.frequency.exponentialRampToValueAtTime(closing ? 2150 : 680, t + 0.16);
    servoGain.gain.setValueAtTime(0.0001, t);
    servoGain.gain.linearRampToValueAtTime(0.16, t + 0.02);
    servoGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    servo.connect(servoGain).connect(dest);
    servo.start(t);
    servo.stop(t + 0.22);

    if (closing) {
      const clink = ctx.createOscillator();
      const clinkGain = ctx.createGain();
      clink.type = 'triangle';
      clink.frequency.setValueAtTime(1420, t + 0.13);
      clink.frequency.exponentialRampToValueAtTime(420, t + 0.21);
      clinkGain.gain.setValueAtTime(0.0001, t + 0.13);
      clinkGain.gain.linearRampToValueAtTime(0.28, t + 0.14);
      clinkGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      clink.connect(clinkGain).connect(dest);
      clink.start(t + 0.13);
      clink.stop(t + 0.26);
    }
  }
}

export const soundFx = new StarkSoundEngine();
