/**
 * PROJECT 13 :: NOISE_GATE_WORKLET
 *
 * Discord-style input-sensitivity gate: passes audio only while the input level
 * is above a threshold (dBFS), with attack/release smoothing and a hold window
 * so word endings are not clipped. Runs entirely locally; no data leaves the
 * audio thread except a throttled level report for UI meters.
 *
 * Parameters (k-rate):
 *  - threshold: gate threshold in dBFS (-90..0)
 *  - enabled:   0 = hard bypass (gain 1), 1 = gate active
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -55, minValue: -90, maxValue: 0, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this._gain = 1
    this._holdSamples = 0
    this._holdLength = Math.round(sampleRate * 0.2) // 200ms hold after voice stops
    this._attackCoef = Math.exp(-1 / (sampleRate * 0.004)) // ~4ms open
    this._releaseCoef = Math.exp(-1 / (sampleRate * 0.11)) // ~110ms close
    this._lastPostTime = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || input.length === 0 || !input[0]) return true

    const enabled = (parameters.enabled[0] ?? 1) >= 0.5
    const threshold = parameters.threshold[0] ?? -55

    const ch0 = input[0]
    const n = ch0.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += ch0[i] * ch0[i]
    const rms = Math.sqrt(sum / n)
    const db = 20 * Math.log10(rms + 1e-10)

    let target
    if (!enabled) {
      target = 1
    } else if (db >= threshold) {
      target = 1
      this._holdSamples = this._holdLength
    } else if (this._holdSamples > 0) {
      target = 1
      this._holdSamples -= n
    } else {
      target = 0
    }

    // Smooth the gain envelope once, apply to every channel.
    const coef = target > this._gain ? this._attackCoef : this._releaseCoef
    let g = this._gain
    for (let c = 0; c < output.length; c++) {
      const inCh = input[c] || ch0
      const outCh = output[c]
      g = this._gain
      for (let i = 0; i < n; i++) {
        g = coef * g + (1 - coef) * target
        outCh[i] = inCh[i] * g
      }
    }
    this._gain = g

    // ~30 level reports per second for UI meters.
    if (currentTime - this._lastPostTime > 0.033) {
      this._lastPostTime = currentTime
      this.port.postMessage({ db, open: target === 1, gain: g })
    }
    return true
  }
}

registerProcessor('p13-noise-gate', NoiseGateProcessor)
