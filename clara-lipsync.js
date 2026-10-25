// Clara lip-sync driver: turns an audio spectrum (ElevenLabs SDK getOutputByteFrequencyData,
// or any AnalyserNode run through the same resampling) into morph-target + jaw-bone values.
// The SDK returns 1024 bins spanning 100..8000 Hz (linear), so bin->Hz is fixed below.
export const SDK_MIN_HZ = 100, SDK_MAX_HZ = 8000;

export const VISEMES = ['V_Open','V_Wide','V_Tight_O','V_Explosive','V_Dental_Lip','V_Lip_Open','V_Affricate','V_Tight'];
export const MORPH_NAMES = ['Jaw_Open', ...VISEMES];
export const JAW_BONE_MAX_RAD = 0.35;

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

// Resample a raw AnalyserNode byte spectrum into the SDK's 100..8000 Hz layout (same maths as the SDK).
export function resampleVoiceRange(raw, out, sampleRate) {
  const hzPerBin = sampleRate / 2 / raw.length;
  const minBin = Math.floor(SDK_MIN_HZ / hzPerBin);
  const maxBin = Math.min(Math.ceil(SDK_MAX_HZ / hzPerBin), raw.length);
  const n = maxBin - minBin;
  for (let i = 0; i < out.length; i++) {
    const pos = (i / out.length) * n, lo = minBin + Math.floor(pos), hi = Math.min(lo + 1, maxBin - 1), t = pos - Math.floor(pos);
    out[i] = Math.round(raw[lo] * (1 - t) + raw[hi] * t);
  }
  return out;
}

const hiRatioPre = hi => clamp01((hi - 0.08) / 0.35);

export class LipSync {
  constructor() {
    this.v = Object.fromEntries(MORPH_NAMES.map(n => [n, 0]));   // smoothed outputs 0..1
    this.jaw = 0;            // 0..1 -> jaw bone angle = jaw * JAW_BONE_MAX_RAD
    this.level = 0; this.prevLevel = 0; this.slope = 0; this.ratioDb = 0; this.rLo = -16; this.rHi = -7; this.hiRatio = 0;
    this.explosive = 0; this.mute = false;
  }
  _bandMean(d, loHz, hiHz) {
    const hz = (SDK_MAX_HZ - SDK_MIN_HZ) / d.length;
    const a = Math.max(0, Math.floor((loHz - SDK_MIN_HZ) / hz)), b = Math.min(d.length, Math.ceil((hiHz - SDK_MIN_HZ) / hz));
    let s = 0; for (let i = a; i < b; i++) s += d[i]; return b > a ? s / (b - a) / 255 : 0;
  }
  // average linear power in a band (bytes are dB-scaled: 0..255 -> -100..-30 dB, the AnalyserNode default)
  _bandPow(d, loHz, hiHz) {
    const hz = (SDK_MAX_HZ - SDK_MIN_HZ) / d.length;
    const a = Math.max(0, Math.floor((loHz - SDK_MIN_HZ) / hz)), b = Math.min(d.length, Math.ceil((hiHz - SDK_MIN_HZ) / hz));
    let s = 0; for (let i = a; i < b; i++) s += Math.pow(10, (d[i] / 255 * 70 - 100) / 10); return b > a ? s / (b - a) : 0;
  }
  // d: Uint8Array spectrum (SDK layout). dt: seconds since last call. Pass d=null to relax to closed mouth.
  update(d, dt) {
    let target = Object.fromEntries(MORPH_NAMES.map(n => [n, 0])), jawT = 0;
    if (this.mute) d = null;   // e.g. the SDK says the agent stopped speaking: ignore the analyser's slow decay tail
    if (d && d.length) {
      const low = this._bandMean(d, 100, 500), f1 = this._bandMean(d, 500, 1200), f2 = this._bandMean(d, 1200, 2800), hi = this._bandMean(d, 3500, 8000);
      const voiced = (low * 0.8 + f1 * 1.2 + f2 * 1.0) / 3;
      // level: spectra from the SDK are dB-scaled bytes; subtract a noise floor and stretch
      const level = clamp01((voiced - 0.10) / 0.42);
      // vowel colour from the balance of low (100-1000 Hz) vs high-formant (1400-3200 Hz) power, in dB
      const pLow = this._bandPow(d, 100, 1000), pMid = this._bandPow(d, 1400, 3200);
      const ratioDb = 10 * Math.log10((pMid + 1e-14) / (pLow + 1e-14));
      this.ratioDb = ratioDb;
      // adaptive normalisation of vowel colour (different voices/EQ shift the ratio): range expands instantly, relaxes slowly to defaults
      const voicedFrame = level > 0.25 && hiRatioPre(hi) < 0.5;
      if (voicedFrame) { this.rLo = Math.min(this.rLo, ratioDb); this.rHi = Math.max(this.rHi, ratioDb); }
      this.rLo += (-16 - this.rLo) * (1 - Math.exp(-dt * 0.08)); this.rHi += (-7 - this.rHi) * (1 - Math.exp(-dt * 0.08));
      const colour = clamp01((ratioDb - this.rLo) / Math.max(4, this.rHi - this.rLo));
      const hiRatio = clamp01((hi - 0.08) / 0.35) * (level > 0.05 || hi > 0.2 ? 1 : 0);
      // slope of the level (EMA): the browser analyser smooths with a slow fall, so a falling level means "closing"
      const rawSlope = (level - this.prevLevel) / Math.max(dt, 1e-3);
      this.slope += (rawSlope - this.slope) * (1 - Math.exp(-dt * 14));
      const closing = this.slope < 0 ? clamp01(1 + this.slope / 0.9) : 1;     // 1 = steady/rising, ->0 when falling fast
      const gate = Math.max(0.05, closing);
      const onset = clamp01((level - this.prevLevel) * 6);
      this.prevLevel = level; this.level = level; this.hiRatio = hiRatio;
      const speech = clamp01((level - 0.04) * 1.6) * gate;
      const voicedW = speech * (1 - hiRatio * 0.7);
      const oo = clamp01((0.38 - colour) / 0.38), ee = clamp01((colour - 0.62) / 0.38), ah = 1 - Math.max(oo, ee) * 0.8;
      this.oo = oo; this.ee = ee;
      jawT = clamp01(Math.pow(speech, 0.8) * (0.55 + 0.45 * ah));
      target.Jaw_Open = jawT * 0.85;
      target.V_Open = voicedW * ah * 0.75;
      target.V_Lip_Open = voicedW * (0.25 + 0.4 * ah);
      target.V_Wide = voicedW * ee * 0.8;
      target.V_Tight = voicedW * ee * 0.25;
      target.V_Tight_O = voicedW * oo * 0.9;
      // consonant-ish: fricative energy -> teeth on lip / affricate; sharp onsets -> plosive pop
      target.V_Dental_Lip = speech * hiRatio * 0.55;
      target.V_Affricate = speech * hiRatio * 0.45;
      this.explosive = Math.max(this.explosive - dt * 6, onset * speech);   // short pulse that decays
      target.V_Explosive = this.explosive * 0.7;
      jawT *= 1 - hiRatio * 0.4;
    } else { this.level *= 0.8; this.prevLevel = 0; this.slope = 0; this.explosive = 0; }
    // asymmetric smoothing: fast attack, slower release (frame-rate independent)
    const att = 1 - Math.exp(-dt * 38), rel = 1 - Math.exp(-dt * 16);
    for (const n of MORPH_NAMES) { const c = this.v[n], t = target[n]; this.v[n] = c + (t - c) * (t > c ? att : rel); }
    this.jaw += (jawT - this.jaw) * (jawT > this.jaw ? att : rel);
    return this;
  }
  get jawAngle() { return this.jaw * JAW_BONE_MAX_RAD; }
}
