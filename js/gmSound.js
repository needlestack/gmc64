// gmSound.js - GameMaker Sound (.SND file) handler
//
// === ARCHITECTURE ===
// gmSound parses GameMaker sound files and provides playback via Web Audio API.
// Each sound instance is independent, matching how gmSprite/gmScene work.
//
// === SOUND FILE FORMAT ===
// GameMaker sounds are stored as .SND files with this structure:
//   [0-4]   Magic number: 00 A0 47 45 4B
//   [5-10]  Filename (6 PETSCII characters)
//   [11]    Unknown
//   [12]    Repeat count (0 = play once, N = repeat N times)
//   [13]    Repeat delay (0-255, maps to 0-4 seconds)
//   [14]    Speed (XOR'd with 128)
//   [15]    EQ flag (high nibble) and volume (low nibble)
//   [16]    Unknown
//   [17]    Frame count
//   [18+]   Frame data (16 bytes per frame)
//
// === FRAME FORMAT (16 bytes each) ===
//   [0]     Waveform: 0x10=triangle, 0x20=sawtooth, 0x40=square, 0x80=noise
//   [1]     Attack (high nibble) / Decay (low nibble)
//   [2]     Sustain (high nibble) / Release (low nibble)
//   [3]     Frequency high byte
//   [4]     Frequency low byte
//   [5]     Speed (pitch sweep, XOR'd with 128)
//   [6]     Pulse width high byte
//   [7]     Pulse width low byte
//   [8]     Duration (in NTSC frames, ~60fps)
//   [9]     EQ low pass (low nibble, 0-7)
//   [10]    EQ band pass (high nibble, 0-15) / high pass (low nibble, 0-15)
//   [11]    Tie flag (high nibble = 0x80 means tie is on)
//   [12-15] Padding
//
// === SID CHIP EMULATION ===
// The C64's SID chip is emulated using Web Audio API:
//   - Triangle, sawtooth, square waves via PeriodicWave
//   - Noise via LFSR (Linear Feedback Shift Register)
//   - ADSR envelope via GainNode automation
//   - Frequency sweep via scheduled frequency changes

class gmSound {

    // Waveform constants (matches SID register values)
    static WAVE_TRIANGLE = 0x10;
    static WAVE_SAWTOOTH = 0x20;
    static WAVE_SQUARE = 0x40;
    static WAVE_NOISE = 0x80;

    // Waveform names for display
    static WAVE_NAMES = {
        0x10: "triangle",
        0x20: "sawtooth",
        0x40: "square",
        0x80: "noise"
    };

    // Attack times in ms (from C64 Programmer's Reference Guide)
    static ATTACK_TIMES = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];

    // Decay/Release times in ms (from C64 Programmer's Reference Guide)
    static DECAY_TIMES = [6, 24, 48, 72, 114, 168, 204, 240, 300, 700, 1500, 2400, 3000, 9000, 15000, 24000];

    // File structure constants
    static HEADER_SIZE = 18;
    static FRAME_SIZE = 16;
    static MAGIC = [0x00, 0xA0, 0x47, 0x45, 0x4B];

    // Persistent LFSR state - SID's noise LFSR runs continuously, never resets
    // This makes each noise trigger sound different (like real SID)
    static noiseLfsr = 0x7FFFFF;

    // Haptic feedback: fire the mobile vibration API when a sound uses the
    // noise waveform (0x80) or contains a low-frequency (< HAPTIC_LOW_FREQ_HZ)
    // frame. Only relevant on touch devices — desktop browsers ignore
    // navigator.vibrate. Music (gmMusic) is deliberately excluded — this
    // fires from gmSound.play() only, so a laser or explosion buzzes but
    // a bass note in a song doesn't.
    static HAPTIC_ENABLED = true;
    static HAPTIC_LOW_FREQ_HZ = 100;   // sub-100Hz counts as "bass thump"
    static HAPTIC_MAX_MS = 40;          // cap so a long explosion doesn't rattle for seconds

    constructor(fileData) {
        this.name = "";
        this.repeatCount = 0;
        this.repeatDelay = 0;
        this.speed = 0;
        this.eqOn = false;
        this.volume = 15;
        this.frames = [];

        // Audio state
        this.activeSources = [];
        this.audioContext = null;
        this.masterGain = null;

        if (fileData) {
            this.parse(fileData);
        }
    }

    // Parse sound file data
    parse(fileData) {
        // Verify magic number (warn but continue - some files may have different headers)
        let magicValid = true;
        for (let i = 0; i < 5; i++) {
            if (fileData[i] !== gmSound.MAGIC[i]) {
                magicValid = false;
                break;
            }
        }
        // Magic mismatch is tolerated (some period disks have alternate
        // header formats and the sound still plays), so no branch here.

        // Header fields
        this.name = this._decodeString(fileData.slice(5, 11));
        this.repeatCount = fileData[12];
        this.repeatDelay = fileData[13];
        this.speed = 255 - fileData[14];
        this.eqOn = (fileData[15] >> 4) > 7;
        this.volume = fileData[15] & 0x0F;
        const frameCount = fileData[17];

        // Parse frames
        this.frames = [];
        for (let i = 0; i < frameCount; i++) {
            const o = gmSound.HEADER_SIZE + (i * gmSound.FRAME_SIZE);
            this.frames.push({
                wave: fileData[o],
                att: fileData[o + 1] >> 4,
                dec: fileData[o + 1] & 0x0F,
                sus: fileData[o + 2] >> 4,
                rel: fileData[o + 2] & 0x0F,
                freqHi: fileData[o + 3],
                freqLo: fileData[o + 4],
                spd: fileData[o + 5] ^ 0x80, // XOR 128: file format to display format
                pulseHi: fileData[o + 6],
                pulseLo: fileData[o + 7],
                dur: fileData[o + 8],
                eqLowPass: fileData[o + 9] & 0x0F,      // 0-7
                eqBandPass: fileData[o + 10] >> 4,      // 0-15
                eqHighPass: fileData[o + 10] & 0x0F,    // 0-15
                tie: (fileData[o + 11] >> 4) === 8
            });
        }
    }

    // Decode screen code string
    _decodeString(bytes) {
        return decodeString(bytes).trim();
    }

    // Encode string to screen codes (6 bytes, padded with spaces)
    _encodeString(str) {
        // Use encodeString from c64lib for screen codes (uppercase)
        return encodeString(str.toUpperCase(), 6);
    }

    // Serialize sound data back to file format
    // Returns Uint8Array suitable for writing to D64
    serialize() {
        const frameCount = this.frames.length;
        const totalSize = gmSound.HEADER_SIZE + (frameCount * gmSound.FRAME_SIZE) + 1; // +1 for trailing 00
        const data = new Uint8Array(totalSize);

        // Magic number (bytes 0-4)
        for (let i = 0; i < 5; i++) {
            data[i] = gmSound.MAGIC[i];
        }

        // Name (bytes 5-10)
        const nameBytes = this._encodeString(this.name);
        for (let i = 0; i < 6; i++) {
            data[5 + i] = nameBytes[i];
        }

        // Unknown byte 11 (observed as 0x02 in files)
        data[11] = 0x02;

        // Repeat count (byte 12)
        data[12] = this.repeatCount;

        // Repeat delay (byte 13)
        data[13] = this.repeatDelay;

        // Speed (byte 14) - stored inverted
        data[14] = 255 - this.speed;

        // EQ on (bit 7) + Volume (bits 0-3) (byte 15)
        // eqOn: when true, high nibble > 7 (we use 0x80)
        data[15] = (this.eqOn ? 0x80 : 0x00) | (this.volume & 0x0F);

        // Unknown byte 16 (observed as 0x00)
        data[16] = 0x00;

        // Frame count (byte 17)
        data[17] = frameCount;

        // Serialize frames
        for (let i = 0; i < frameCount; i++) {
            const frame = this.frames[i];
            const o = gmSound.HEADER_SIZE + (i * gmSound.FRAME_SIZE);

            // Wave type (byte 0)
            data[o] = frame.wave;

            // Attack (high nibble) + Decay (low nibble) (byte 1)
            data[o + 1] = ((frame.att & 0x0F) << 4) | (frame.dec & 0x0F);

            // Sustain (high nibble) + Release (low nibble) (byte 2)
            data[o + 2] = ((frame.sus & 0x0F) << 4) | (frame.rel & 0x0F);

            // Frequency hi (byte 3)
            data[o + 3] = frame.freqHi;

            // Frequency lo (byte 4)
            data[o + 4] = frame.freqLo;

            // Speed/sweep (byte 5) - XOR 128 to convert display format to file format
            data[o + 5] = frame.spd ^ 0x80;

            // Pulse width hi (byte 6)
            data[o + 6] = frame.pulseHi;

            // Pulse width lo (byte 7)
            data[o + 7] = frame.pulseLo;

            // Duration (byte 8)
            data[o + 8] = frame.dur;

            // EQ low pass (byte 9, low nibble)
            data[o + 9] = frame.eqLowPass & 0x0F;

            // EQ band pass (high nibble) + high pass (low nibble) (byte 10)
            data[o + 10] = ((frame.eqBandPass & 0x0F) << 4) | (frame.eqHighPass & 0x0F);

            // Tie flag (byte 11) - 0x80 when tie is on
            data[o + 11] = frame.tie ? 0x80 : 0x00;

            // Remaining bytes in frame (12-15) are zeros
            data[o + 12] = 0x00;
            data[o + 13] = 0x00;
            data[o + 14] = 0x00;
            data[o + 15] = 0x00;
        }

        // Trailing 00 byte
        data[totalSize - 1] = 0x00;

        return data;
    }

    // Decode speed byte to sweep parameters
    // Returns { steps: number of freqHi steps, direction: +1 for up, -1 for down, active: boolean }
    // GM behavior:
    //   0 = no sweep (dead zone)
    //   1-127 = sweep UP (higher value = more steps = faster)
    //     1 = slowest up (1 step), 127 = fastest up (127 steps)
    //   128-254 = sweep DOWN (lower value = more steps = faster)
    //     128 = fastest down (127 steps), 254 = slowest down (1 step)
    //   255 = no sweep (dead zone)
    // Dead zone in practice: 0, 1, 254, 255 (too slow to hear within max duration)
    _decodeSpeed(byte) {
        if (byte === 0 || byte === 255) {
            return { steps: 0, direction: 0, active: false };
        } else if (byte >= 1 && byte <= 127) {
            // Sweep UP: 1 = 1 step (slow), 127 = 127 steps (fast)
            return { steps: byte, direction: 1, active: true };
        } else {
            // byte >= 128 && byte <= 254: Sweep DOWN
            // 128 = 127 steps (fast), 254 = 1 step (slow)
            return { steps: 255 - byte, direction: -1, active: true };
        }
    }

    // Convert C64 frequency register to Hz
    _freqToHz(hi, lo) {
        const fn = (hi << 8) | lo;
        return fn * 0.06097;
    }

    // Initialize audio context (must be called after user interaction)
    async initAudio() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 0.1;
            this.masterGain.connect(this.audioContext.destination);
        }
        // Resume if suspended (browsers require user gesture)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    // Stop all active playback
    stop() {
        // Cancel any pending batch scheduling
        if (this._scheduleTimerId) {
            clearTimeout(this._scheduleTimerId);
            this._scheduleTimerId = null;
        }
        this._currentRepeat = Infinity; // Prevent further batches

        // Cancel all frame change timers
        if (this._frameTimerIds) {
            this._frameTimerIds.forEach(id => clearTimeout(id));
            this._frameTimerIds = [];
        }

        this.activeSources.forEach(source => {
            try {
                source.stop();
            } catch (e) {
                // Already stopped
            }
        });
        this.activeSources = [];
    }

    // Pause playback - freezes audio exactly where it is.
    pause() {
        if (this.audioContext && this.activeSources.length > 0) {
            this.audioContext.suspend();
        }
    }

    // Resume playback from where it was paused.
    resume() {
        if (this.audioContext) {
            this.audioContext.resume();
        }
    }

    // Check if sound is currently playing
    isPlaying() {
        return this.activeSources && this.activeSources.length > 0;
    }

    // Play the sound
    async play(audioContext = null, masterGain = null) {
        // Use provided context or initialize our own
        if (audioContext) {
            this.audioContext = audioContext;
            this.masterGain = masterGain || audioContext.destination;
        } else {
            await this.initAudio();
        }

        this.stop();

        // Fire haptic feedback before we schedule audio — the vibration
        // should feel synchronous with the "trigger" event, not delayed
        // to when the first sample comes out of the mixer.
        this._triggerHaptic();

        const repeatDelaySeconds = (this.repeatDelay / 255) * 8;

        // Schedule repeats in batches to avoid overwhelming the audio system
        const batchSize = 8; // Number of repeats per batch
        this._currentRepeat = 0;
        this._repeatDelaySeconds = repeatDelaySeconds;
        this._batchSize = batchSize;
        this._scheduleTimerId = null;
        this._frameTimerIds = []; // Track frame change timers for cleanup

        // Start first batch with small delay to ensure all scheduling happens before playback
        this._scheduleBatch(this.audioContext.currentTime + 0.02); // 20ms buffer
    }

    // Set callback for frame changes during playback
    // callback receives (frameIndex, repeatIndex)
    setOnFrameChange(callback) {
        this._onFrameChange = callback;
    }

    // Scan frames for noise waveform or sub-100Hz frequency and, if found,
    // trigger a short vibration. Duration scales with the loudest frame's
    // envelope volume so a whisper-quiet sample doesn't get a punchy buzz.
    // No-op silently if the browser has no vibration API (all desktops).
    _triggerHaptic() {
        if (!gmSound.HAPTIC_ENABLED) return;
        if (typeof navigator === 'undefined' || !navigator.vibrate) return;

        let hasNoise = false;
        let hasLowFreq = false;
        let peakVol = 0;
        for (const frame of this.frames) {
            if (frame.wave === gmSound.WAVE_NOISE) hasNoise = true;
            const hz = this._freqToHz(frame.freqHi, frame.freqLo);
            if (hz > 0 && hz < gmSound.HAPTIC_LOW_FREQ_HZ) hasLowFreq = true;
            // frame.sus is 0-15; approximates the loudness we care about
            if (frame.sus > peakVol) peakVol = frame.sus;
        }
        if (!hasNoise && !hasLowFreq) return;

        // Scale 8..HAPTIC_MAX_MS by peak sustain — noise-only chirps get a
        // brief tick, thunder-y explosions get the full buzz.
        const volFactor = Math.max(0.25, peakVol / 15);
        const ms = Math.round(8 + (gmSound.HAPTIC_MAX_MS - 8) * volFactor);
        try { navigator.vibrate(ms); } catch (e) { /* some browsers throw in iframes */ }
    }

    // Schedule a batch of repeats
    _scheduleBatch(startTime) {
        if (this._currentRepeat > this.repeatCount) {
            return; // All repeats done
        }

        let time = startTime;
        const batchEnd = Math.min(this._currentRepeat + this._batchSize, this.repeatCount + 1);

        // Global speed affects duration interpretation
        // speed 254 = normal (1x), speed 127 = half speed (2x duration), etc.
        // Higher speed value = faster playback = shorter durations
        const speedMultiplier = (this.speed > 0) ? (254 / this.speed) : 254;

        for (let r = this._currentRepeat; r < batchEnd; r++) {
            for (let i = 0; i < this.frames.length; i++) {
                const frame = this.frames[i];
                const freq = this._freqToHz(frame.freqHi, frame.freqLo);
                const waveType = gmSound.WAVE_NAMES[frame.wave] || 'square';

                // Envelope durations (not affected by speed)
                const att = gmSound.ATTACK_TIMES[frame.att] / 1000;
                const dec = gmSound.DECAY_TIMES[frame.dec] / 1000;
                // Duration in seconds, scaled by global speed
                const dur = frame.dur * 0.01666667 * speedMultiplier; // NTSC frame to seconds (gate time)

                // Determine if this is the last frame of the last repeat
                const isLastFrame = (i === this.frames.length - 1) && (r === this.repeatCount);

                // Release only applies to the LAST frame when tie is on
                // All other frames are hard cuts at dur
                const rel = (frame.tie && isLastFrame) ? gmSound.DECAY_TIMES[frame.rel] / 1000 : 0;

                // Tiny gap between frames when tie is off (simulates SID gate)
                const gap = frame.tie ? 0 : 0.005; // 5ms gap

                // Sound plays for dur (minus gap if tie off), plus release on last frame
                const soundDuration = dur - gap + rel;

                const sweep = this._decodeSpeed(frame.spd);

                // Create sound source
                let source;
                if (waveType === "triangle") {
                    source = this._createTriangle(freq);
                } else if (waveType === "sawtooth") {
                    source = this._createSawtooth(freq);
                } else if (waveType === "square") {
                    const pulseWidth = (frame.pulseHi << 8) | frame.pulseLo;
                    source = this._createSquare(freq, pulseWidth);
                } else if (waveType === "noise") {
                    source = this._createNoise(soundDuration, frame.freqHi, frame.freqLo, sweep);
                } else {
                    source = this._createTriangle(freq);
                }

                // Per-sound volume (0..15) scales the whole envelope. Until
                // we plumbed this through, sound-maker's volume slider was
                // a no-op — it changed the stored value but the envelope
                // always ramped to 1.0.
                const vol = (this.volume & 0x0F) / 15;
                const sustainLevel = (frame.sus / 15) * vol;

                // Create envelope
                const { gainNode, schedule } = this._createEnvelope(att, dec, sustainLevel, rel, soundDuration, vol);

                // Frequency sweep for non-noise waveforms
                if (waveType !== "noise" && sweep.active) {
                    const sweepTotalDuration = 255 * 0.01666667; // Max duration for sweep timing
                    const segmentDuration = sweepTotalDuration / sweep.steps;
                    const effectiveDuration = Math.min(dur, sweepTotalDuration);

                    for (let j = 1; j <= sweep.steps; j++) {
                        const hi = (frame.freqHi + sweep.direction * j + 256) % 256;
                        const freqStep = this._freqToHz(hi, frame.freqLo);
                        const t = time + j * segmentDuration;
                        if (t > time + effectiveDuration) break;
                        source.frequency.setValueAtTime(freqStep, t);
                    }
                }

                // Create filter chain if EQ is enabled
                if (this.eqOn) {
                    const filterChain = this._createFilterChain(frame.eqLowPass, frame.eqBandPass, frame.eqHighPass);
                    source.connect(filterChain.input);
                    filterChain.output.connect(gainNode);
                } else {
                    source.connect(gainNode);
                }
                gainNode.connect(this.masterGain);

                // Start and schedule
                source.start(time);
                schedule(time);
                source.stop(time + soundDuration);

                this.activeSources.push(source);

                // Auto-cleanup when source finishes to prevent memory buildup
                source.onended = () => {
                    const idx = this.activeSources.indexOf(source);
                    if (idx !== -1) {
                        this.activeSources.splice(idx, 1);
                    }
                    try {
                        source.disconnect();
                        gainNode.disconnect();
                    } catch (e) {
                        // Already disconnected
                    }
                };

                // Schedule frame change callback
                if (this._onFrameChange) {
                    const frameIndex = i;
                    const repeatIndex = r;
                    const delay = (time - this.audioContext.currentTime) * 1000;
                    const timerId = setTimeout(() => {
                        if (this._onFrameChange) {
                            this._onFrameChange(frameIndex, repeatIndex);
                        }
                    }, Math.max(0, delay));
                    this._frameTimerIds.push(timerId);
                }

                time += dur; // Next frame starts after gate time (release overlaps)
            }

            // Delay between repeats
            if (r < this.repeatCount) {
                time += this._repeatDelaySeconds;
            }
        }

        this._currentRepeat = batchEnd;

        // Schedule next batch if there are more repeats
        if (this._currentRepeat <= this.repeatCount) {
            // Schedule next batch to start slightly before current batch ends
            const nextBatchDelay = (time - this.audioContext.currentTime - 0.5) * 1000;
            this._scheduleTimerId = setTimeout(() => {
                this._scheduleBatch(time);
            }, Math.max(100, nextBatchDelay));
        }
    }

    // Play a single note at the specified frequency and duration
    // Used by gmMusic to play instrument notes
    // Uses the first frame's settings for waveform, ADSR, pulse width, etc.
    // frequency: Hz
    // duration: seconds
    // startTime: audioContext time to start (defaults to now)
    // isTied: if true, note sustains; if false, staccato tap
    playNote(audioContext, masterGain, frequency, duration, startTime = null, isTied = true) {
        this.audioContext = audioContext;
        this.masterGain = masterGain || audioContext.destination;

        if (startTime === null) {
            startTime = audioContext.currentTime;
        }

        if (this.frames.length === 0) return;

        const frame = this.frames[0];
        const waveType = gmSound.WAVE_NAMES[frame.wave] || 'square';

        // ADSR from frame settings
        const att = gmSound.ATTACK_TIMES[frame.att] / 1000;
        const dec = gmSound.DECAY_TIMES[frame.dec] / 1000;
        const rel = gmSound.DECAY_TIMES[frame.rel] / 1000;
        const sustainLevel = frame.sus / 15;

        // Create sound source at the specified frequency
        let source;
        if (waveType === "triangle") {
            source = this._createTriangle(frequency);
        } else if (waveType === "sawtooth") {
            source = this._createSawtooth(frequency);
        } else if (waveType === "square") {
            const pulseWidth = (frame.pulseHi << 8) | frame.pulseLo;
            source = this._createSquare(frequency, pulseWidth);
        } else if (waveType === "noise") {
            source = this._createNoise(duration, Math.floor(frequency / 256), Math.floor(frequency) % 256);
        } else {
            source = this._createTriangle(frequency);
        }

        // Create gain node for envelope
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;

        // Connect source -> gain -> master
        source.connect(gainNode);
        gainNode.connect(this.masterGain);

        if (isTied) {
            // Tied/legato: full ADSR, sustain fills nearly all of note duration
            // Release starts at 99% of duration for nearly seamless transitions
            const gateTime = duration * 0.99;
            const sustainDuration = Math.max(0, gateTime - att - dec);

            const attackEnd = startTime + att;
            const decayEnd = attackEnd + dec;
            const sustainEnd = decayEnd + sustainDuration;
            const releaseEnd = sustainEnd + rel;

            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(1.0, attackEnd);
            gainNode.gain.linearRampToValueAtTime(sustainLevel, decayEnd);
            gainNode.gain.setValueAtTime(sustainLevel, sustainEnd);
            gainNode.gain.linearRampToValueAtTime(0, releaseEnd);

            source.start(startTime);
            source.stop(releaseEnd + 0.01);
        } else {
            // Staccato: note plays for ~75% of duration, then releases
            // This creates separation between notes without being too choppy
            const gateTime = duration * 0.75;
            const sustainDuration = Math.max(0, gateTime - att - dec);

            const attackEnd = startTime + att;
            const decayEnd = attackEnd + dec;
            const sustainEnd = decayEnd + sustainDuration;
            const releaseEnd = sustainEnd + rel;

            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(1.0, attackEnd);
            gainNode.gain.linearRampToValueAtTime(sustainLevel, decayEnd);
            gainNode.gain.setValueAtTime(sustainLevel, sustainEnd);
            gainNode.gain.linearRampToValueAtTime(0, releaseEnd);

            source.start(startTime);
            source.stop(releaseEnd + 0.01);
        }

        this.activeSources.push(source);

        // Auto-cleanup when source finishes to prevent memory buildup
        source.onended = () => {
            const idx = this.activeSources.indexOf(source);
            if (idx !== -1) {
                this.activeSources.splice(idx, 1);
            }
            // Disconnect nodes to free audio resources
            try {
                source.disconnect();
                gainNode.disconnect();
            } catch (e) {
                // Already disconnected
            }
        };

        return source;
    }

    // Create SID-like triangle wave using band-limited PeriodicWave
    _createTriangle(frequency) {
        const oscillator = this.audioContext.createOscillator();
        const harmonics = 8;
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        for (let n = 1; n <= harmonics; n++) {
            if (n % 2 === 1) {
                const amp = 8 / (Math.PI ** 2 * n ** 2) * (n % 4 === 1 ? 1 : -1);
                imag[n] = amp;
            }
        }

        const wave = this.audioContext.createPeriodicWave(real, imag, { disableNormalization: true });
        oscillator.setPeriodicWave(wave);
        oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        return oscillator;
    }

    // Create SID-like sawtooth wave using band-limited PeriodicWave
    // Real sawtooth uses ALL harmonics with amplitude 2/n (alternating sign)
    // More harmonics = buzzier sound (SID has effectively infinite harmonics due to digital synthesis)
    _createSawtooth(frequency) {
        const oscillator = this.audioContext.createOscillator();
        const harmonics = 32;  // More harmonics for buzzier SID-like sound
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        // Sawtooth Fourier series: sum of (2/n) * sin(n*x) for n = 1, 2, 3...
        // Using negative values gives a falling sawtooth like the SID
        for (let n = 1; n <= harmonics; n++) {
            imag[n] = -2.0 / (n * Math.PI);
        }

        const wave = this.audioContext.createPeriodicWave(real, imag, { disableNormalization: true });
        oscillator.setPeriodicWave(wave);
        oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        return oscillator;
    }

    // Create SID-like square/pulse wave with variable pulse width using band-limited PeriodicWave
    // SID pulse width is 12-bit (0-4095):
    //   0 = 0% duty (silent), 2048 = 50% duty (classic square), 4095 = ~100% duty (silent)
    // Fourier series for pulse wave: sum of (2/(n*π)) * sin(n*π*d) * cos(n*x) for ALL n
    _createSquare(frequency, pulseWidth12bit = 2048) {
        // Convert to duty cycle (0.0 to 1.0)
        pulseWidth12bit = Math.max(1, Math.min(pulseWidth12bit, 4094));
        const dutyCycle = pulseWidth12bit / 4095;

        const oscillator = this.audioContext.createOscillator();

        const harmonics = 32;
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        // DC offset for pulse wave
        real[0] = 2 * dutyCycle - 1;

        // Pulse wave Fourier series uses ALL harmonics (not just odd)
        // Only at exactly 50% duty cycle do the even harmonics cancel out
        for (let n = 1; n <= harmonics; n++) {
            const amp = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * dutyCycle);
            imag[n] = isNaN(amp) ? 0 : amp;
        }

        const wave = this.audioContext.createPeriodicWave(real, imag, { disableNormalization: true });
        oscillator.setPeriodicWave(wave);
        oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        return oscillator;
    }

    // Create SID-like filter chain
    // The SID has lowpass, bandpass, and highpass filters that can be combined
    // lowPass: 0-7 controls lowpass cutoff (0=off, 7=most filtering)
    // bandPass: 0-15 controls bandpass (0=off, 15=strongest)
    // highPass: 0-15 controls highpass (0=off, 15=most filtering)
    _createFilterChain(lowPass, bandPass, highPass) {
        // GameMaker EQ interpretation:
        // The three controls (lo 0-7, mid 0-15, hi 0-15) likely control a single
        // SID-style state-variable filter where:
        // - lo controls how much low frequencies pass (0=cut, 7=pass)
        // - mid controls mid-frequency resonance/presence (0=cut, 15=pass)
        // - hi controls how much high frequencies pass (0=cut, 15=pass)
        //
        // At 0/0/0: heavy filtering on all bands (but not silence)
        // At 7/15/15: neutral/bypass
        //
        // Implementation: Use shelving filters which cut/boost without going silent

        // Input gain node - SID filter has inherent volume drop when engaged
        const inputGain = this.audioContext.createGain();
        inputGain.gain.value = 0.63; // ~-4dB drop when EQ is on

        // Low shelf: controls bass frequencies
        // 0 = -6dB cut, 7 = 0dB (neutral) - lighter touch on bass
        const loShelf = this.audioContext.createBiquadFilter();
        loShelf.type = 'lowshelf';
        loShelf.frequency.value = 300; // Shelf frequency
        loShelf.gain.value = (lowPass / 7) * 6 - 6; // 0->-6dB, 7->0dB

        // Mid peaking: controls mid frequencies
        // 0 = -18dB cut at 1kHz, 15 = 0dB (neutral)
        const midPeak = this.audioContext.createBiquadFilter();
        midPeak.type = 'peaking';
        midPeak.frequency.value = 1000;
        midPeak.Q.value = 1.0;
        midPeak.gain.value = (bandPass / 15) * 18 - 18; // 0->-18dB, 15->0dB

        // High shelf: controls treble frequencies
        // 0 = -12dB cut, 15 = 0dB (neutral)
        const hiShelf = this.audioContext.createBiquadFilter();
        hiShelf.type = 'highshelf';
        hiShelf.frequency.value = 3000; // Shelf frequency
        hiShelf.gain.value = (highPass / 15) * 12 - 12; // 0->-12dB, 15->0dB

        // Chain them together
        inputGain.connect(loShelf);
        loShelf.connect(midPeak);
        midPeak.connect(hiShelf);

        return {
            input: inputGain,
            output: hiShelf
        };
    }

    // Create SID-like noise using LFSR
    // The SID noise is band-limited because the LFSR only shifts at the rate
    // set by the frequency register, and the output holds between shifts.
    // Lower frequency = fewer shifts = more "chunky" sound
    // Higher frequency = more shifts = smoother/brighter noise
    // sweep: optional { steps, direction, active } from _decodeSpeed
    _createNoise(durationSeconds, freqHi, freqLo, sweep = null) {
        const sampleRate = this.audioContext.sampleRate;
        const bufferSize = Math.floor(sampleRate * durationSeconds);
        const buffer = this.audioContext.createBuffer(1, bufferSize, sampleRate);
        const output = buffer.getChannelData(0);

        // Sweep setup (if active)
        // Sweep speed is constant regardless of sound duration
        let segmentSamples = bufferSize; // No sweep = one segment
        if (sweep && sweep.active) {
            const totalDuration = 255 * 0.01666667;
            segmentSamples = Math.floor((totalDuration * sampleRate) / sweep.steps);
        }

        // Use persistent LFSR state (SID's LFSR runs continuously, never resets)
        let lfsr = gmSound.noiseLfsr;
        let currentValue = 0;
        let samplesSinceShift = 0;

        for (let i = 0; i < bufferSize; i++) {
            // Calculate current frequency (with sweep if active)
            let hi = freqHi;
            if (sweep && sweep.active) {
                const segmentIndex = Math.floor(i / segmentSamples);
                hi = (freqHi + sweep.direction * segmentIndex + 256) % 256;
            }
            const frequency = (hi << 8) | freqLo;

            // SID runs at ~1MHz, frequency register controls LFSR shift rate
            // Scale factor to approximate SID timing feel
            const shiftInterval = Math.max(1, Math.floor(sampleRate / (Math.max(1, frequency) * 1)));

            // Track samples since last shift
            samplesSinceShift++;
            if (samplesSinceShift >= shiftInterval) {
                samplesSinceShift = 0;
                const bit = ((lfsr >> 22) ^ (lfsr >> 17)) & 1;
                lfsr = ((lfsr << 1) | bit) & 0x7FFFFF;

                // Extract 8 bits from specific LFSR positions (SID behavior)
                const sidNoiseByte =
                    ((lfsr >> 22) & 1) << 7 |
                    ((lfsr >> 20) & 1) << 6 |
                    ((lfsr >> 16) & 1) << 5 |
                    ((lfsr >> 13) & 1) << 4 |
                    ((lfsr >> 11) & 1) << 3 |
                    ((lfsr >> 7) & 1) << 2 |
                    ((lfsr >> 4) & 1) << 1 |
                    ((lfsr >> 2) & 1);

                currentValue = (sidNoiseByte / 127.5) - 1;
            }

            output[i] = currentValue;
        }

        // Save LFSR state for next noise sound
        gmSound.noiseLfsr = lfsr;

        const noiseSource = this.audioContext.createBufferSource();
        noiseSource.buffer = buffer;
        return noiseSource;
    }

    // Create ADSR envelope
    // soundDuration = how long the sound plays (dur - gap + release)
    // release = release time (0 for hard cut, >0 for fade out on last frame)
    _createEnvelope(attack, decay, sustain, release, soundDuration, peak = 1.0) {
        const gainNode = this.audioContext.createGain();

        const schedule = (startTime) => {
            // Gate time is soundDuration minus release
            const gateTime = soundDuration - release;
            const gateEnd = startTime + gateTime;

            gainNode.gain.setValueAtTime(0, startTime);

            if (gateTime >= attack + decay) {
                // Normal case: full attack, full decay, sustain until gate end
                const tAttackEnd = startTime + attack;
                const tDecayEnd = tAttackEnd + decay;

                gainNode.gain.linearRampToValueAtTime(peak, tAttackEnd);
                gainNode.gain.linearRampToValueAtTime(sustain, tDecayEnd);
                gainNode.gain.setValueAtTime(sustain, gateEnd);
                if (release > 0) {
                    gainNode.gain.linearRampToValueAtTime(0, gateEnd + release);
                } else {
                    // Hard cut
                    gainNode.gain.setValueAtTime(0, gateEnd);
                }
            } else if (gateTime >= attack) {
                // Gate ends during decay phase
                const tAttackEnd = startTime + attack;
                const decayProgress = (gateTime - attack) / decay;
                const levelAtGateEnd = peak - (peak - sustain) * decayProgress;

                gainNode.gain.linearRampToValueAtTime(peak, tAttackEnd);
                gainNode.gain.linearRampToValueAtTime(levelAtGateEnd, gateEnd);
                if (release > 0) {
                    gainNode.gain.linearRampToValueAtTime(0, gateEnd + release);
                } else {
                    gainNode.gain.setValueAtTime(0, gateEnd);
                }
            } else {
                // Gate ends during attack phase
                const attackProgress = gateTime / attack;
                const levelAtGateEnd = peak * attackProgress;

                gainNode.gain.linearRampToValueAtTime(levelAtGateEnd, gateEnd);
                if (release > 0) {
                    gainNode.gain.linearRampToValueAtTime(0, gateEnd + release);
                } else {
                    gainNode.gain.setValueAtTime(0, gateEnd);
                }
            }
        };

        return { gainNode, schedule };
    }

    // Get human-readable description
    getDescription() {
        let desc = `Sound: ${this.name}\n`;
        desc += `Repeats: ${this.repeatCount}, Delay: ${this.repeatDelay}\n`;
        desc += `Volume: ${this.volume}, EQ: ${this.eqOn ? 'on' : 'off'}\n`;
        desc += `Frames: ${this.frames.length}\n\n`;

        this.frames.forEach((frame, i) => {
            desc += `Frame ${i + 1}:\n`;
            desc += `  Wave: ${gmSound.WAVE_NAMES[frame.wave] || 'unknown'}\n`;
            desc += `  ADSR: ${frame.att}/${frame.dec}/${frame.sus}/${frame.rel}\n`;
            desc += `  Freq: ${frame.freqHi}/${frame.freqLo} (${this._freqToHz(frame.freqHi, frame.freqLo).toFixed(1)} Hz)\n`;
            desc += `  Duration: ${frame.dur} frames\n`;
            const sweep = this._decodeSpeed(frame.spd);
            desc += `  Sweep: ${frame.spd} (${sweep.active ? sweep.direction > 0 ? 'UP' : 'DOWN' : 'off'}, ${sweep.steps} steps)\n`;
            if (frame.wave === gmSound.WAVE_SQUARE) {
                desc += `  Pulse: ${(frame.pulseHi << 8) | frame.pulseLo}\n`;
            }
            desc += '\n';
        });

        return desc;
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmSound = gmSound;
}
