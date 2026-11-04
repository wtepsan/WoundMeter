// Microphone capture for voice questions: 16 kHz, 16-bit mono PCM WAV, the input format of
// Muse Voice Transcribe. Audio stays in memory; nothing is written to browser storage.

export const MAX_RECORDING_SECONDS = 60;
const TARGET_RATE = 16000;

export interface Recorder {
  /** Stop and return base64 WAV (no data: prefix) and its duration. */
  stop: () => Promise<{ base64: string; seconds: number }>;
  /** Stop and discard everything recorded. */
  cancel: () => void;
}

export function recordingSupported(): boolean {
  return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && "AudioContext" in window;
}

export async function startRecording(onAutoStop?: () => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor keeps this dependency-free; the audio is short push-to-talk speech.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let samples = 0;
  let finished = false;
  processor.onaudioprocess = (event) => {
    if (finished) return;
    const data = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(data);
    samples += data.length;
    if (samples / context.sampleRate >= MAX_RECORDING_SECONDS) onAutoStop?.();
  };
  source.connect(processor);
  processor.connect(context.destination);

  const release = () => {
    finished = true;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };

  return {
    cancel: () => {
      release();
      chunks.length = 0;
    },
    stop: async () => {
      const rate = context.sampleRate;
      release();
      const joined = new Float32Array(samples);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk.subarray(0, Math.min(chunk.length, samples - offset)), offset);
        offset += chunk.length;
      }
      const resampled = await resample(joined, rate);
      return { base64: toBase64(encodeWav(resampled)), seconds: resampled.length / TARGET_RATE };
    },
  };
}

async function resample(input: Float32Array, rate: number): Promise<Float32Array> {
  if (rate === TARGET_RATE || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * TARGET_RATE) / rate));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE);
  const buffer = offline.createBuffer(1, input.length, rate);
  buffer.copyToChannel(new Float32Array(input), 0);
  const node = offline.createBufferSource();
  node.buffer = buffer;
  node.connect(offline.destination);
  node.start();
  return (await offline.startRendering()).getChannelData(0);
}

function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
