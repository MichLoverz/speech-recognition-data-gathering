/**
 * AudioWorklet: forwards the microphone's raw Float32 samples to the page
 * in blocks of 2048 frames (~43 ms at 48 kHz), at the context's native rate.
 *
 * Unlike HireNote's live recorder, nothing is resampled here. The page
 * resamples each finished take to 16 kHz with an OfflineAudioContext, which
 * applies a proper band-limited filter (no aliasing), and works the same in
 * every browser regardless of which context rates it accepts.
 */
class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.block = new Float32Array(2048);
        this.fill = 0;
    }

    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
            for (let i = 0; i < ch.length; i++) {
                this.block[this.fill++] = ch[i];
                if (this.fill === this.block.length) {
                    this.port.postMessage(this.block.slice(0));
                    this.fill = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('capture', CaptureProcessor);
