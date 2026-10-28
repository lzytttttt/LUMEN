/**
 * forge/fx/sound.ts —— 五类轻音（D6：默认关，开启后 ≤ -18LUFS 的短音）。
 * 只用 WebAudio oscillator，不加载任何音频资源；同一时刻最多一个音。
 */
export type ForgeSoundKind = 'deal' | 'land' | 'gate' | 'combo' | 'premiere'

interface Tone {
  freq: number
  to: number
  ms: number
  gain: number
  type: OscillatorType
}

const TONES: Record<ForgeSoundKind, Tone> = {
  deal: { freq: 420, to: 520, ms: 90, gain: 0.05, type: 'sine' },
  land: { freq: 180, to: 120, ms: 120, gain: 0.07, type: 'triangle' },
  gate: { freq: 140, to: 90, ms: 200, gain: 0.08, type: 'sawtooth' },
  combo: { freq: 640, to: 880, ms: 80, gain: 0.04, type: 'sine' },
  premiere: { freq: 300, to: 480, ms: 260, gain: 0.06, type: 'sine' },
}

let context: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    context ??= new Ctor()
    if (context.state === 'suspended') void context.resume()
    return context
  } catch {
    return null
  }
}

export function playForgeSound(kind: ForgeSoundKind, enabled: boolean): void {
  if (!enabled) return
  const ctx = audioContext()
  if (!ctx) return
  const tone = TONES[kind]
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = tone.type
  osc.frequency.setValueAtTime(tone.freq, now)
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, tone.to), now + tone.ms / 1000)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(tone.gain, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.ms / 1000)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + tone.ms / 1000 + 0.02)
}

export function disposeSound(): void {
  if (!context) return
  void context.close().catch(() => undefined)
  context = null
}
