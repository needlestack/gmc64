// gmMusic.js - GameMaker Music (.SNG file) handler
//
// === ARCHITECTURE ===
// gmMusic parses GameMaker music files and provides playback via Web Audio API.
// Each music instance is independent, matching how gmSprite/gmScene/gmSound work.
// Songs have 3 channels, each with its own instrument and note sequence.
//
// === PERFORMANCE-OPTIMIZED PLAYBACK ===
// Uses 3 persistent oscillators (one per channel) matching SID hardware:
//   - Oscillators run continuously during playback
//   - Frequency changes scheduled via AudioParam automation
//   - ADSR envelopes scheduled on persistent gain nodes
//   - No per-note object creation = no GC pressure
//
// === MUSIC FILE FORMAT (.SNG) ===
// Reverse-engineered through testing with known note patterns.
//
// Header (bytes 0-33):
//   [0-1]   Load address: E0 0B
//   [2-4]   Magic: "GEK" (47 45 4B)
//   [5-10]  Song name (6 PETSCII characters)
//   [11-19] Unknown/unused
//   [20]    Tempo (80 ≈ 140 BPM, scales linearly)
//   [21]    Channel 1 instrument index (0-13)
//   [22]    Channel 2 instrument index (0-13)
//   [23]    Channel 3 instrument index (0-13)
//   [24-26] Header delimiter: FF FF FF
//   [27-33] Preamble (7 bytes, unknown purpose, varies per song)
//
// Note data (bytes 34+):
//   Notes are grouped BY CHANNEL, not by beat.
//   Each channel's notes are sequential <duration> <pitch> pairs.
//   FF FF marks end of channel, single FF marks end of file.
//   Channel order: Ch1 (highest voice), Ch2 (mid), Ch3 (lowest/bass)
//
// === DURATION ENCODING ===
// Duration byte = base value + optional flags
//
// Base values (bits 0-4):
//   0x00 = 32nd note (1/8 beat)
//   0x01 = 16th note (1/4 beat)
//   0x03 = 8th note (1/2 beat)
//   0x05 = dotted 8th (3/4 beat)
//   0x07 = quarter note (1 beat)
//   0x0B = dotted quarter (1.5 beats)
//   0x0F = half note (2 beats)
//   0x17 = dotted half (3 beats)
//   0x1F = whole note (4 beats)
//
// Flags (bits 5-6):
//   +0x20 = tied (legato) - note sustains for 90% of duration
//   +0x40 = rest - pitch byte is ignored
//
// === PITCH ENCODING ===
// Pitch is a semitone value where 0x26 (38 decimal) = A440.
// Each +1 = one semitone up, each -1 = one semitone down.
// 12 semitones per octave.
//
// === INSTRUMENTS ===
// 14 instrument types (0-13):
//   0  = off (default triangle)
//   1  = bass (filtered triangle)
//   2  = cow bell (filtered square)
//   3  = cymbal (low-pass filtered noise)
//   4  = flute (triangle, soft attack)
//   5  = guitar (medium-filtered sawtooth)
//   6  = harpsichord (lightly-filtered sawtooth)
//   7  = piano (heavily-filtered sawtooth)
//   8  = saxophone (filtered sawtooth, soft attack)
//   9  = snare (high-pass filtered noise)
//   10 = synthesizer (unfiltered sawtooth)
//   11 = trumpet (filtered sawtooth, soft attack, short release)
//   12 = violin (filtered sawtooth, soft attack, long release)
//   13 = xylophone (triangle, percussive)

class gmMusic {
    // Base BPM at tempo 80 (measured against VICE emulator)
    static BASE_BPM = 140;

    // Instrument definitions - waveform, ADSR, and transpose settings
    // wave: 'triangle', 'sawtooth', 'square', 'noise'
    // att/dec/rel: indices into SID timing tables
    // sus: 0-15 sustain level
    // pulseWidth: 0-4095 for square wave duty cycle
    // transpose: semitones to shift pitch
    static INSTRUMENTS = {
        0:  { name: 'off',         wave: 'triangle', att: 0,  dec: 4,  sus: 12, rel: 4,  pulseWidth: 2048, transpose: 0  },
        1:  { name: 'bass',        wave: 'triangle', att: 0,  dec: 5,  sus: 10, rel: 3,  pulseWidth: 2048, transpose: 0  },
        2:  { name: 'cow bell',    wave: 'square',   att: 0,  dec: 6,  sus: 0,  rel: 5,  pulseWidth: 1024, transpose: 24 },
        3:  { name: 'cymbal',      wave: 'noise',    att: 0,  dec: 9,  sus: 3,  rel: 8,  pulseWidth: 2048, transpose: 24 },
        4:  { name: 'flute',       wave: 'triangle', att: 4,  dec: 3,  sus: 13, rel: 5,  pulseWidth: 2048, transpose: 0  },
        5:  { name: 'guitar',      wave: 'square',   att: 0,  dec: 7,  sus: 4,  rel: 5,  pulseWidth: 1536, transpose: 0  },
        6:  { name: 'harpsichord', wave: 'square',   att: 0,  dec: 5,  sus: 2,  rel: 3,  pulseWidth: 2048, transpose: 0  },
        7:  { name: 'piano',       wave: 'square',   att: 0,  dec: 8,  sus: 5,  rel: 6,  pulseWidth: 1536, transpose: 0  },
        8:  { name: 'saxophone',   wave: 'sawtooth', att: 3,  dec: 4,  sus: 11, rel: 5,  pulseWidth: 2048, transpose: 0  },
        9:  { name: 'snare',       wave: 'noise',    att: 0,  dec: 4,  sus: 0,  rel: 2,  pulseWidth: 2048, transpose: 24 },
        10: { name: 'synthesizer', wave: 'sawtooth', att: 0,  dec: 4,  sus: 12, rel: 4,  pulseWidth: 2048, transpose: 0  },
        11: { name: 'trumpet',     wave: 'sawtooth', att: 3,  dec: 4,  sus: 10, rel: 3,  pulseWidth: 2048, transpose: 0  },
        12: { name: 'violin',      wave: 'sawtooth', att: 5,  dec: 4,  sus: 11, rel: 7,  pulseWidth: 2048, transpose: 0  },
        13: { name: 'xylophone',   wave: 'triangle', att: 0,  dec: 6,  sus: 0,  rel: 5,  pulseWidth: 2048, transpose: 0  }
    };

    // SID ADSR timing tables (milliseconds)
    static ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
    static DECAY_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 700, 1500, 2400, 3000, 9000, 15000, 24000];

    constructor(fileData) {
        this.fileData = fileData ? new Uint8Array(fileData) : null;
        this.name = '';
        this.tempo = 80;
        this.bpm = gmMusic.BASE_BPM;
        this.quarterNoteDuration = 60 / gmMusic.BASE_BPM;
        this.instruments = [0, 0, 0];
        this.channels = [[], [], []];

        // Audio state
        this.audioCtx = null;
        this.isPlaying = false;
        this.stopTime = 0;

        // Persistent audio nodes (created on play, destroyed on stop)
        this.channelOscillators = [null, null, null];
        this.channelGains = [null, null, null];
        this.channelNoiseBuffers = [null, null, null];
        this.masterGain = null;

        if (fileData) {
            this.parse();
        }
    }

    // Creates a new blank song for the editor
    static createBlank(options = {}) {
        const song = new gmMusic();
        song.name = (options.name || 'NEW').padEnd(6, ' ').substring(0, 6);
        song.tempo = options.tempo !== undefined ? options.tempo : 80;
        song.instruments = options.instruments || [7, 12, 1]; // piano, violin, bass
        song.bpm = (song.tempo / 80) * gmMusic.BASE_BPM;
        song.quarterNoteDuration = 60 / song.bpm;
        song.channels = [[], [], []];
        return song;
    }

    parse() {
        this.name = this._decodeName(this.fileData.slice(5, 11));
        this.tempo = this.fileData[20];
        this.instruments = [
            this.fileData[21],
            this.fileData[22],
            this.fileData[23]
        ];

        this.bpm = (this.tempo / 80) * gmMusic.BASE_BPM;
        this.quarterNoteDuration = 60 / this.bpm;

        this.channels = [[], [], []];

        let i = 34;
        let currentChannel = 0;

        while (i < this.fileData.length && currentChannel < 3) {
            const byte = this.fileData[i];

            if (byte === 0xFF) {
                if (i + 1 < this.fileData.length && this.fileData[i + 1] === 0xFF) {
                    currentChannel++;
                    i += 2;
                } else {
                    break;
                }
                continue;
            }

            const durationByte = byte;
            const pitchByte = this.fileData[i + 1];

            // Null slots have rest flag but duration index 0 - they're empty space
            // that tied notes sustain through (vs real rests which end tied notes)
            const isRest = (durationByte & 0x40) !== 0;
            const durationIndex = durationByte & 0x1F;
            const isNullSlot = isRest && durationIndex === 0;

            this.channels[currentChannel].push({
                durationByte: durationByte,
                pitch: pitchByte,
                isRest: isRest,
                isNullSlot: isNullSlot,
                isTied: (durationByte & 0x20) !== 0,
                duration: this._getDurationMultiplier(durationByte)
            });

            i += 2;
        }
    }

    _decodeName(bytes) {
        return decodeString(bytes).trim();
    }

    _getDurationMultiplier(durationByte) {
        const base = durationByte & 0x1F;
        const durations = {
            0x00: 0.125, 0x01: 0.25, 0x03: 0.5, 0x05: 0.75,
            0x07: 1.0, 0x0B: 1.5, 0x0F: 2.0, 0x17: 3.0, 0x1F: 4.0
        };
        return durations[base] || 1.0;
    }

    _pitchToFrequency(pitch, transpose = 0) {
        const a440Pitch = 0x26;
        const semitonesFromA440 = pitch + transpose - a440Pitch;
        return 440 * Math.pow(2, semitonesFromA440 / 12);
    }

    // Serialize song to .SNG format
    serialize() {
        // Calculate channel sizes (note bytes only, 2 bytes per note)
        const ch1Size = this.channels[0].length * 2;
        const ch2Size = this.channels[1].length * 2;
        const ch3Size = this.channels[2].length * 2;

        // Channel end offsets (cumulative, INCLUDING the FF FF delimiters)
        const ch1EndOffset = ch1Size + 2;                      // ch1 notes + FF FF
        const ch2EndOffset = ch1Size + 2 + ch2Size + 2;        // ch1 + ch2 + both FF FFs
        const totalNoteBytes = ch1Size + ch2Size + ch3Size + 5; // all notes + 2 + 2 + 1 delimiters

        // Total file size: 34 byte header + all note data including delimiters
        const size = 34 + totalNoteBytes;
        const data = new Uint8Array(size);
        let offset = 0;

        // Bytes 0-1: Load address
        data[offset++] = 0xE0;
        data[offset++] = 0x0B;

        // Bytes 2-4: Magic "GEK"
        data[offset++] = 0x47; // G
        data[offset++] = 0x45; // E
        data[offset++] = 0x4B; // K

        // Bytes 5-10: Song name (6 screen code chars, space-padded)
        const nameBytes = encodeString(this.name.toUpperCase(), 6);
        for (let i = 0; i < 6; i++) {
            data[offset++] = nameBytes[i];
        }

        // Byte 11: Unknown (always 0x03 in original files)
        data[offset++] = 0x03;

        // Bytes 12-13: Total note bytes (little-endian)
        data[offset++] = totalNoteBytes & 0xFF;
        data[offset++] = (totalNoteBytes >> 8) & 0xFF;

        // Bytes 14-15: Always 0x00 0x00
        data[offset++] = 0x00;
        data[offset++] = 0x00;

        // Bytes 16-17: Channel 1 end offset (little-endian)
        data[offset++] = ch1EndOffset & 0xFF;
        data[offset++] = (ch1EndOffset >> 8) & 0xFF;

        // Bytes 18-19: Channel 2 end offset (little-endian)
        data[offset++] = ch2EndOffset & 0xFF;
        data[offset++] = (ch2EndOffset >> 8) & 0xFF;

        // Byte 20: Tempo
        data[offset++] = this.tempo;

        // Bytes 21-23: Instruments
        data[offset++] = this.instruments[0];
        data[offset++] = this.instruments[1];
        data[offset++] = this.instruments[2];

        // Bytes 24-26: Delimiter FF FF FF
        data[offset++] = 0xFF;
        data[offset++] = 0xFF;
        data[offset++] = 0xFF;

        // Bytes 27-33: Preamble (FF padding + AD marker)
        for (let i = 0; i < 6; i++) data[offset++] = 0xFF;
        data[offset++] = 0xAD;

        // Note data starting at byte 34
        for (let ch = 0; ch < 3; ch++) {
            for (const note of this.channels[ch]) {
                data[offset++] = note.durationByte;
                data[offset++] = note.pitch;
            }
            if (ch < 2) {
                // Channels 0 and 1 end with FF FF delimiter
                data[offset++] = 0xFF;
                data[offset++] = 0xFF;
            } else {
                // Channel 2 ends with single FF (end of song)
                data[offset++] = 0xFF;
            }
        }

        return data.slice(0, offset);
    }

    // === PLAYBACK ===

    play(startBeat = 0) {
        if (this.isPlaying) {
            this.stop();
        }

        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.isPlaying = true;

        // Master gain for overall volume
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 0.3;
        this.masterGain.connect(this.audioCtx.destination);

        const audioStartTime = this.audioCtx.currentTime + 0.05;
        let maxEndTime = audioStartTime;

        // Calculate total song duration for noise buffer pre-generation
        let maxChannelDuration = 0;
        for (let ch = 0; ch < 3; ch++) {
            let totalBeats = 0;
            for (const note of this.channels[ch]) {
                totalBeats += note.duration;
            }
            const channelDuration = totalBeats * this.quarterNoteDuration;
            maxChannelDuration = Math.max(maxChannelDuration, channelDuration);
        }

        // Create persistent oscillator and gain for each channel
        for (let ch = 0; ch < 3; ch++) {
            const instrumentIndex = this.instruments[ch];
            const instrument = gmMusic.INSTRUMENTS[instrumentIndex] || gmMusic.INSTRUMENTS[0];

            // Create gain node for ADSR envelope
            const gainNode = this.audioCtx.createGain();
            gainNode.gain.setValueAtTime(0, audioStartTime);
            gainNode.connect(this.masterGain);
            this.channelGains[ch] = gainNode;

            // Create oscillator based on waveform type
            if (instrument.wave === 'noise') {
                // Pre-generate noise buffer - longer to accommodate slow playback rates
                // At 0.25x playback, a 120s buffer gives 480s of audio
                const noiseBuffer = this._createNoiseBuffer(120);
                const noiseSource = this.audioCtx.createBufferSource();
                noiseSource.buffer = noiseBuffer;
                noiseSource.loop = true; // Loop for very long songs or slow playback
                noiseSource.connect(gainNode);
                noiseSource.start(audioStartTime);
                this.channelOscillators[ch] = noiseSource;
                this.channelNoiseBuffers[ch] = noiseBuffer;
            } else {
                const osc = this._createOscillator(instrument.wave, instrument.pulseWidth);
                osc.connect(gainNode);
                osc.start(audioStartTime);
                this.channelOscillators[ch] = osc;
            }

            // Schedule all notes for this channel
            const channelEndTime = this._scheduleChannel(ch, audioStartTime, startBeat);
            maxEndTime = Math.max(maxEndTime, channelEndTime);
        }

        this.stopTime = maxEndTime;

        // Auto-stop when song finishes
        const timeUntilEnd = (this.stopTime - this.audioCtx.currentTime) * 1000 + 200;
        this._stopTimeout = setTimeout(() => {
            if (this.isPlaying) {
                this.stop();
            }
        }, timeUntilEnd);
    }

    _scheduleChannel(channel, audioStartTime, startBeat) {
        const instrumentIndex = this.instruments[channel];
        const instrument = gmMusic.INSTRUMENTS[instrumentIndex] || gmMusic.INSTRUMENTS[0];
        const gainNode = this.channelGains[channel];
        const osc = this.channelOscillators[channel];

        // ADSR times in seconds
        const attackTime = gmMusic.ATTACK_MS[instrument.att] / 1000;
        const decayTime = gmMusic.DECAY_MS[instrument.dec] / 1000;
        const releaseTime = gmMusic.DECAY_MS[instrument.rel] / 1000;
        const sustainLevel = instrument.sus / 15;

        const startBeatSeconds = startBeat * this.quarterNoteDuration;
        const notes = this.channels[channel];
        let beatPos = 0;

        for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            let noteDuration = note.duration * this.quarterNoteDuration;
            const noteEndBeat = beatPos + note.duration;

            // Only schedule notes that start at or after startBeat
            if (noteEndBeat > startBeat && !note.isRest) {
                // For tied notes, extend through any following null slots
                // Null slots (duration index 0) are empty space that tied notes sustain through
                // Real rests (duration index > 0) end the tied note
                if (note.isTied) {
                    let extendedEndBeat = noteEndBeat;
                    for (let j = i + 1; j < notes.length; j++) {
                        if (notes[j].isNullSlot) {
                            // Sustain through null slots
                            extendedEndBeat += notes[j].duration;
                        } else {
                            // Stop at real notes or real rests
                            break;
                        }
                    }
                    // Extend to 95% of the way to the next real event
                    const extendedBeats = (extendedEndBeat - beatPos) * 0.95;
                    noteDuration = extendedBeats * this.quarterNoteDuration;
                }

                const noteStartSeconds = beatPos * this.quarterNoteDuration;
                const noteTime = audioStartTime + noteStartSeconds - startBeatSeconds;

                if (noteTime >= audioStartTime) {
                    // Schedule pitch change
                    const freq = this._pitchToFrequency(note.pitch, instrument.transpose);

                    if (instrument.wave === 'noise') {
                        // For noise, control pitch via playbackRate
                        // playbackRate = targetFreq / baseFreq
                        const playbackRate = freq / gmMusic.NOISE_BASE_FREQ;
                        osc.playbackRate.setValueAtTime(playbackRate, noteTime);
                    } else if (osc.frequency) {
                        // For pitched instruments, set frequency directly
                        osc.frequency.setValueAtTime(freq, noteTime);
                    }

                    // Schedule ADSR envelope on the gain node
                    this._scheduleADSR(
                        gainNode,
                        noteTime,
                        noteDuration,
                        attackTime,
                        decayTime,
                        sustainLevel,
                        releaseTime,
                        note.isTied
                    );
                }
            }

            beatPos += note.duration;
        }

        return audioStartTime + (beatPos - startBeat) * this.quarterNoteDuration;
    }

    _scheduleADSR(gainNode, startTime, duration, attack, decay, sustainLevel, release, isTied) {
        // For tied notes: sustain through most of duration, then release
        // For staccato: shorter gate time with separation
        const gateRatio = isTied ? 0.95 : 0.75;
        const gateTime = duration * gateRatio;

        // Calculate envelope timing
        const attackEnd = startTime + Math.min(attack, gateTime * 0.5);
        const decayEnd = attackEnd + Math.min(decay, gateTime - attack);
        const sustainEnd = startTime + gateTime;
        const releaseEnd = sustainEnd + release;

        // SID retrigger gap: On real hardware, the gate bit must go low before
        // going high again to retrigger the envelope. Most music drivers had a
        // few cycles between gate-off and gate-on.
        const rampDuration = 0.001; // 1ms ramp down to avoid click/pop
        const silenceGap = 0.002;   // 2ms of silence before new attack
        const totalGap = rampDuration + silenceGap; // 3ms total
        const gateOffTime = Math.max(0, startTime - totalGap);
        const rampEndTime = Math.max(0, startTime - silenceGap);

        // Cancel any pending automation and ramp to zero BEFORE the new note
        // Using a short ramp instead of instant cut avoids click/pop artifacts
        gainNode.gain.cancelScheduledValues(gateOffTime);
        gainNode.gain.setValueAtTime(gainNode.gain.value, gateOffTime);
        gainNode.gain.linearRampToValueAtTime(0, rampEndTime);

        if (gateTime >= attack + decay) {
            // Full ADSR
            gainNode.gain.linearRampToValueAtTime(1.0, attackEnd);
            gainNode.gain.linearRampToValueAtTime(sustainLevel, decayEnd);
            gainNode.gain.setValueAtTime(sustainLevel, sustainEnd);
            gainNode.gain.linearRampToValueAtTime(0, releaseEnd);
        } else if (gateTime >= attack) {
            // Gate ends during decay
            const decayProgress = (gateTime - attack) / decay;
            const levelAtGateEnd = 1.0 - (1.0 - sustainLevel) * decayProgress;
            gainNode.gain.linearRampToValueAtTime(1.0, attackEnd);
            gainNode.gain.linearRampToValueAtTime(levelAtGateEnd, sustainEnd);
            gainNode.gain.linearRampToValueAtTime(0, releaseEnd);
        } else {
            // Gate ends during attack
            const attackProgress = gateTime / attack;
            gainNode.gain.linearRampToValueAtTime(attackProgress, sustainEnd);
            gainNode.gain.linearRampToValueAtTime(0, releaseEnd);
        }
    }

    _createOscillator(waveType, pulseWidth = 2048) {
        const osc = this.audioCtx.createOscillator();

        if (waveType === 'triangle') {
            osc.setPeriodicWave(this._createTriangleWave());
        } else if (waveType === 'sawtooth') {
            osc.setPeriodicWave(this._createSawtoothWave());
        } else if (waveType === 'square') {
            osc.setPeriodicWave(this._createSquareWave(pulseWidth));
        } else {
            osc.type = 'triangle'; // Fallback
        }

        // Set initial frequency (will be updated per-note)
        osc.frequency.setValueAtTime(440, this.audioCtx.currentTime);

        return osc;
    }

    _createTriangleWave() {
        const harmonics = 16;
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        for (let n = 1; n <= harmonics; n++) {
            if (n % 2 === 1) {
                const amp = 8 / (Math.PI ** 2 * n ** 2) * (n % 4 === 1 ? 1 : -1);
                imag[n] = amp;
            }
        }

        return this.audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
    }

    _createSawtoothWave() {
        const harmonics = 32;
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        for (let n = 1; n <= harmonics; n++) {
            imag[n] = -2.0 / (n * Math.PI);
        }

        return this.audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
    }

    _createSquareWave(pulseWidth12bit = 2048) {
        pulseWidth12bit = Math.max(1, Math.min(pulseWidth12bit, 4094));
        const dutyCycle = pulseWidth12bit / 4095;

        const harmonics = 32;
        const real = new Float32Array(harmonics + 1);
        const imag = new Float32Array(harmonics + 1);

        real[0] = 2 * dutyCycle - 1;

        for (let n = 1; n <= harmonics; n++) {
            const amp = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * dutyCycle);
            imag[n] = isNaN(amp) ? 0 : amp;
        }

        return this.audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
    }

    // Base frequency for noise buffer generation
    // Noise pitch is controlled via playbackRate relative to this
    static NOISE_BASE_FREQ = 440;

    _createNoiseBuffer(durationSeconds) {
        const sampleRate = this.audioCtx.sampleRate;
        const bufferSize = Math.floor(sampleRate * durationSeconds);
        const buffer = this.audioCtx.createBuffer(1, bufferSize, sampleRate);
        const output = buffer.getChannelData(0);

        // SID-style LFSR noise with pitch control via shift rate
        // The LFSR value is HELD between shifts - this creates the grainy stepped sound
        // Lower frequency = longer holds = chunkier rumble
        // Higher frequency = shorter holds = brighter hiss
        let lfsr = 0x7FFFFF;
        let currentValue = 0;
        let samplesSinceShift = 0;

        // Shift interval determines how often LFSR advances
        // At base frequency, this sets our reference point for playbackRate
        const shiftInterval = Math.max(1, Math.floor(sampleRate / gmMusic.NOISE_BASE_FREQ));

        for (let i = 0; i < bufferSize; i++) {
            samplesSinceShift++;

            if (samplesSinceShift >= shiftInterval) {
                samplesSinceShift = 0;

                // Shift LFSR
                const bit = ((lfsr >> 22) ^ (lfsr >> 17)) & 1;
                lfsr = ((lfsr << 1) | bit) & 0x7FFFFF;

                // Extract bits from LFSR (SID noise output pattern)
                const noiseByte =
                    ((lfsr >> 22) & 1) << 7 |
                    ((lfsr >> 20) & 1) << 6 |
                    ((lfsr >> 16) & 1) << 5 |
                    ((lfsr >> 13) & 1) << 4 |
                    ((lfsr >> 11) & 1) << 3 |
                    ((lfsr >> 7) & 1) << 2 |
                    ((lfsr >> 4) & 1) << 1 |
                    ((lfsr >> 2) & 1);

                currentValue = (noiseByte / 127.5) - 1;
            }

            // Hold the value until next shift - this is key for grainy SID sound
            output[i] = currentValue;
        }

        return buffer;
    }

    stop() {
        this.isPlaying = false;

        if (this._stopTimeout) {
            clearTimeout(this._stopTimeout);
            this._stopTimeout = null;
        }

        // Stop all oscillators
        for (let ch = 0; ch < 3; ch++) {
            if (this.channelOscillators[ch]) {
                try {
                    this.channelOscillators[ch].stop();
                    this.channelOscillators[ch].disconnect();
                } catch (e) {
                    // Already stopped
                }
                this.channelOscillators[ch] = null;
            }
            if (this.channelGains[ch]) {
                try {
                    this.channelGains[ch].disconnect();
                } catch (e) {
                    // Already disconnected
                }
                this.channelGains[ch] = null;
            }
            this.channelNoiseBuffers[ch] = null;
        }

        if (this.masterGain) {
            try {
                this.masterGain.disconnect();
            } catch (e) {}
            this.masterGain = null;
        }

        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
    }

    pause() {
        if (this.audioCtx && this.isPlaying) {
            this.audioCtx.suspend();
        }
    }

    resume() {
        if (this.audioCtx && this.isPlaying) {
            this.audioCtx.resume();
        }
    }

    // Set playback volume (0-15, matching GameMaker's range)
    setVolume(volume) {
        // Clamp to valid range
        volume = Math.max(0, Math.min(15, volume));
        // Map 0-15 to 0-0.3 (0.3 is our baseline max to avoid clipping)
        const gain = (volume / 15) * 0.3;
        if (this.masterGain) {
            // Use setValueAtTime for smooth transition
            this.masterGain.gain.setValueAtTime(gain, this.audioCtx.currentTime);
        }
    }

    // Play a single preview note (for music editor)
    // audioCtx: external audio context to use
    // destination: where to connect (e.g., a gain node)
    // instrumentIndex: 0-13 instrument type
    // frequency: Hz
    // duration: seconds
    playPreviewNote(audioCtx, destination, instrumentIndex, frequency, duration) {
        const instrument = gmMusic.INSTRUMENTS[instrumentIndex] || gmMusic.INSTRUMENTS[0];

        // ADSR times
        const attack = gmMusic.ATTACK_MS[instrument.att] / 1000;
        const decay = gmMusic.DECAY_MS[instrument.dec] / 1000;
        const release = gmMusic.DECAY_MS[instrument.rel] / 1000;
        const sustainLevel = instrument.sus / 15;

        // Gate time (staccato style for preview)
        const gateTime = duration * 0.75;
        const totalDuration = gateTime + release + 0.05;

        // Create oscillator
        let source;
        if (instrument.wave === 'noise') {
            // Generate noise at base frequency, then use playbackRate for pitch
            const playbackRate = frequency / gmMusic.NOISE_BASE_FREQ;
            // Buffer needs to be longer if slowed down
            const bufferDuration = totalDuration * Math.max(1, 1 / playbackRate) + 0.5;
            const sampleRate = audioCtx.sampleRate;
            const bufferSize = Math.floor(sampleRate * bufferDuration);
            const buffer = audioCtx.createBuffer(1, bufferSize, sampleRate);
            const output = buffer.getChannelData(0);

            // SID-style LFSR with proper hold behavior
            let lfsr = 0x7FFFFF;
            let currentValue = 0;
            let samplesSinceShift = 0;
            const shiftInterval = Math.max(1, Math.floor(sampleRate / gmMusic.NOISE_BASE_FREQ));

            for (let i = 0; i < bufferSize; i++) {
                samplesSinceShift++;
                if (samplesSinceShift >= shiftInterval) {
                    samplesSinceShift = 0;
                    const bit = ((lfsr >> 22) ^ (lfsr >> 17)) & 1;
                    lfsr = ((lfsr << 1) | bit) & 0x7FFFFF;
                    const noiseByte =
                        ((lfsr >> 22) & 1) << 7 | ((lfsr >> 20) & 1) << 6 |
                        ((lfsr >> 16) & 1) << 5 | ((lfsr >> 13) & 1) << 4 |
                        ((lfsr >> 11) & 1) << 3 | ((lfsr >> 7) & 1) << 2 |
                        ((lfsr >> 4) & 1) << 1 | ((lfsr >> 2) & 1);
                    currentValue = (noiseByte / 127.5) - 1;
                }
                output[i] = currentValue;
            }

            source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = playbackRate;
        } else {
            source = audioCtx.createOscillator();
            const harmonics = 32;
            const real = new Float32Array(harmonics + 1);
            const imag = new Float32Array(harmonics + 1);

            if (instrument.wave === 'triangle') {
                for (let n = 1; n <= harmonics; n++) {
                    if (n % 2 === 1) {
                        imag[n] = 8 / (Math.PI ** 2 * n ** 2) * (n % 4 === 1 ? 1 : -1);
                    }
                }
            } else if (instrument.wave === 'sawtooth') {
                for (let n = 1; n <= harmonics; n++) {
                    imag[n] = -2.0 / (n * Math.PI);
                }
            } else { // square
                const dutyCycle = instrument.pulseWidth / 4095;
                real[0] = 2 * dutyCycle - 1;
                for (let n = 1; n <= harmonics; n++) {
                    const amp = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * dutyCycle);
                    imag[n] = isNaN(amp) ? 0 : amp;
                }
            }

            source.setPeriodicWave(audioCtx.createPeriodicWave(real, imag, { disableNormalization: true }));
            source.frequency.setValueAtTime(frequency, audioCtx.currentTime);
        }

        // Create envelope
        const gainNode = audioCtx.createGain();
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);

        const startTime = audioCtx.currentTime;
        const attackEnd = startTime + Math.min(attack, gateTime * 0.5);
        const decayEnd = attackEnd + Math.min(decay, gateTime - attack);
        const sustainEnd = startTime + gateTime;
        const releaseEnd = sustainEnd + release;

        gainNode.gain.linearRampToValueAtTime(1.0, attackEnd);
        gainNode.gain.linearRampToValueAtTime(sustainLevel, decayEnd);
        gainNode.gain.setValueAtTime(sustainLevel, sustainEnd);
        gainNode.gain.linearRampToValueAtTime(0, releaseEnd);

        source.connect(gainNode);
        gainNode.connect(destination);

        source.start();
        source.stop(releaseEnd + 0.01);

        // Cleanup
        source.onended = () => {
            try {
                source.disconnect();
                gainNode.disconnect();
            } catch (e) {}
        };
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmMusic = gmMusic;
}
