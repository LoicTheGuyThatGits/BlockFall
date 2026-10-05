/**
 * Sound effects, synthesised with the WebAudio API so there are no audio
 * files to download. Every effect is a short oscillator envelope.
 */

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
  }

  /** Must be called from a user gesture: browsers block audio otherwise. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? 0.22 : 0;
  }

  tone({ freq = 440, dur = 0.08, type = 'square', gain = 0.6, slide = 0, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.1, gain = 0.4, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const frames = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Fade the noise out so it does not click.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const env = this.ctx.createGain();
    env.gain.value = gain;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    src.start(t0);
  }

  move() {
    this.tone({ freq: 180, dur: 0.03, type: 'square', gain: 0.25 });
  }

  rotate() {
    this.tone({ freq: 320, dur: 0.05, type: 'triangle', gain: 0.4, slide: 120 });
  }

  lock() {
    this.tone({ freq: 140, dur: 0.07, type: 'square', gain: 0.45, slide: -60 });
    this.noise({ dur: 0.05, gain: 0.12 });
  }

  hold() {
    this.tone({ freq: 500, dur: 0.08, type: 'sine', gain: 0.35, slide: -180 });
  }

  /** Pitch and length scale with the size of the clear. */
  clear(lines, special = false) {
    if (lines <= 0) return;
    const base = [0, 261.6, 329.6, 392, 523.3][Math.min(lines, 4)];
    this.tone({ freq: base, dur: 0.1, type: 'triangle', gain: 0.5 });
    this.tone({ freq: base * 1.5, dur: 0.12, type: 'triangle', gain: 0.4, delay: 0.05 });
    if (lines >= 4) {
      this.tone({ freq: base * 2, dur: 0.18, type: 'square', gain: 0.35, delay: 0.1 });
      this.noise({ dur: 0.2, gain: 0.18, delay: 0.05 });
    }
    if (special) {
      [0, 0.08, 0.16].forEach((d, i) => this.tone({ freq: 660 * (1 + i * 0.25), dur: 0.12, type: 'sine', gain: 0.4, delay: d }));
    }
  }

  garbage() {
    this.noise({ dur: 0.25, gain: 0.3 });
    this.tone({ freq: 90, dur: 0.25, type: 'sawtooth', gain: 0.3, slide: 60 });
  }

  levelUp() {
    [523.3, 659.3, 784].forEach((f, i) => this.tone({ freq: f, dur: 0.12, type: 'square', gain: 0.35, delay: i * 0.06 }));
  }

  gameOver() {
    [392, 349.2, 293.7, 196].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.3, type: 'triangle', gain: 0.4, delay: i * 0.16 })
    );
  }

  ui() {
    this.tone({ freq: 660, dur: 0.04, type: 'sine', gain: 0.25 });
  }

  countdown() {
    this.tone({ freq: 440, dur: 0.15, type: 'square', gain: 0.4 });
  }

  go() {
    this.tone({ freq: 880, dur: 0.25, type: 'square', gain: 0.5 });
  }
}

export const sound = new Sound();