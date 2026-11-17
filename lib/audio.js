/**
 * Microphone capture, resampling and WAV encoding for the recorder.
 *
 *   mic ─► AudioWorklet (native rate, Float32 blocks) ─► page keeps the take
 *       ─► OfflineAudioContext resample to 16 kHz ─► 16-bit mono WAV
 */
export const TARGET_RATE = 16000;

/**
 * Same constraints as HireNote's live recorder (web/resources/js/capture.js):
 * the fine-tuned model will hear browser-processed audio in the product, so the
 * training data is recorded through the same processing.
 */
const CONSTRAINTS = {
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export async function openMic(onBlock, onEnded = () => {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('no-media'), { code: 'no-media' });
    }
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    // Some browsers only pull a worklet that leads to the destination; route it through silence.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    node.port.onmessage = (e) => onBlock(e.data);
    if (ctx.state === 'suspended') await ctx.resume();

    const track = stream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', onEnded);
    const s = (track && track.getSettings) ? track.getSettings() : {};
    return {
        rate: ctx.sampleRate,
        /** Mobile browsers suspend the context when the tab was in the background. */
        async resume() { if (ctx.state !== 'running') await ctx.resume(); },
        // What the browser actually applied (iOS, for one, may ignore some of these).
        settings: {
            echoCancellation: s.echoCancellation ?? null,
            noiseSuppression: s.noiseSuppression ?? null,
            autoGainControl: s.autoGainControl ?? null,
            sampleRate: s.sampleRate ?? ctx.sampleRate,
        },
        close() {
            try { node.disconnect(); } catch {}
            try { stream.getTracks().forEach((t) => t.stop()); } catch {}
            try { ctx.close(); } catch {}
        },
    };
}

export function concat(blocks) {
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const b of blocks) { out.set(b, off); off += b.length; }
    return out;
}

/** Band-limited resample to 16 kHz using the browser's own resampler. */
export async function resample(samples, fromRate) {
    if (fromRate === TARGET_RATE) return samples;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const length = Math.ceil(samples.length * TARGET_RATE / fromRate);
    const off = new OAC(1, length, TARGET_RATE);
    const buf = off.createBuffer(1, samples.length, fromRate);
    buf.getChannelData(0).set(samples);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice(0);
}

/** Float32 [-1, 1] → 16-bit PCM mono WAV ArrayBuffer. */
export function encodeWav(samples, rate = TARGET_RATE) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}

/** Simple level statistics used for the take warnings. */
export function stats(samples, rate = TARGET_RATE) {
    let peak = 0, sum = 0, clipped = 0;
    for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    return {
        durasi: samples.length / rate,
        puncak: peak,
        rms_dbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
        sampel_klip: clipped,
    };
}

/** Peak of a block as 0..100 on a -60..0 dBFS scale, for the live meter. */
export function meterPercent(block) {
    let peak = 0;
    for (let i = 0; i < block.length; i += 4) { const a = Math.abs(block[i]); if (a > peak) peak = a; }
    if (peak <= 0.001) return 0;
    const db = 20 * Math.log10(peak);
    return Math.max(0, Math.min(100, Math.round((db + 60) / 60 * 100)));
}
