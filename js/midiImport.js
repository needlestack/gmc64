// midiImport.js - MIDI file parser and converter for GameMaker music format
//
// Parses Standard MIDI Files (SMF) and converts to gmMusic-compatible data.
// Handles Type 0 (single track) and Type 1 (multi-track) MIDI files.
//
// Usage:
//   const importer = new MidiImport(arrayBuffer);
//   const result = importer.parse();
//   // result.tracks[] contains extracted note data
//   // Use importer.convertToGM(trackMap, options) to create gmMusic data

class MidiImport {
    constructor(arrayBuffer) {
        this.data = new Uint8Array(arrayBuffer);
        this.pos = 0;

        // Parsed MIDI data
        this.format = 0;
        this.numTracks = 0;
        this.ticksPerQuarter = 480; // Default, overwritten by header
        this.tracks = [];
        this.tempoChanges = []; // {tick, microsecondsPerQuarter}
    }

    // Read variable-length quantity (VLQ)
    readVLQ() {
        let value = 0;
        let byte;
        do {
            byte = this.data[this.pos++];
            value = (value << 7) | (byte & 0x7F);
        } while (byte & 0x80);
        return value;
    }

    // Read fixed-size big-endian integer
    readInt(bytes) {
        let value = 0;
        for (let i = 0; i < bytes; i++) {
            value = (value << 8) | this.data[this.pos++];
        }
        return value;
    }

    // Read ASCII string
    readString(length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(this.data[this.pos++]);
        }
        return str;
    }

    // Parse the MIDI file
    parse() {
        this.pos = 0;

        // Parse header chunk
        const headerChunk = this.readString(4);
        if (headerChunk !== 'MThd') {
            throw new Error('Invalid MIDI file: missing MThd header');
        }

        const headerLength = this.readInt(4);
        if (headerLength !== 6) {
            throw new Error('Invalid MIDI header length');
        }

        this.format = this.readInt(2);
        this.numTracks = this.readInt(2);
        const timeDivision = this.readInt(2);

        // Time division: if bit 15 is 0, it's ticks per quarter note
        // If bit 15 is 1, it's SMPTE timing (not commonly used)
        if (timeDivision & 0x8000) {
            // SMPTE timing - convert to approximate ticks per quarter
            const fps = -(((timeDivision >> 8) & 0xFF) - 256);
            const ticksPerFrame = timeDivision & 0xFF;
            // Assume 120 BPM for conversion
            this.ticksPerQuarter = Math.round(fps * ticksPerFrame * 0.5);
        } else {
            this.ticksPerQuarter = timeDivision;
        }

        // Parse track chunks
        for (let t = 0; t < this.numTracks; t++) {
            const track = this.parseTrack();
            if (track) {
                this.tracks.push(track);
            }
        }

        // If no tempo was specified, use default 120 BPM (500000 µs/quarter)
        if (this.tempoChanges.length === 0) {
            this.tempoChanges.push({ tick: 0, microsecondsPerQuarter: 500000 });
        }

        return {
            format: this.format,
            numTracks: this.tracks.length,
            ticksPerQuarter: this.ticksPerQuarter,
            tracks: this.tracks,
            tempoChanges: this.tempoChanges
        };
    }

    parseTrack() {
        const chunkType = this.readString(4);
        if (chunkType !== 'MTrk') {
            throw new Error('Invalid track chunk: expected MTrk, got ' + chunkType);
        }

        const chunkLength = this.readInt(4);
        const chunkEnd = this.pos + chunkLength;

        const track = {
            name: '',
            notes: [],      // {startTick, endTick, note, velocity, channel}
            activeNotes: {} // Track note-on events waiting for note-off
        };

        let absoluteTick = 0;
        let runningStatus = 0;

        while (this.pos < chunkEnd) {
            const deltaTime = this.readVLQ();
            absoluteTick += deltaTime;

            let statusByte = this.data[this.pos];

            // Check for running status (reuse previous status byte)
            if (statusByte < 0x80) {
                statusByte = runningStatus;
            } else {
                this.pos++;
                if (statusByte < 0xF0) {
                    runningStatus = statusByte;
                }
            }

            const eventType = statusByte & 0xF0;
            const channel = statusByte & 0x0F;

            if (statusByte === 0xFF) {
                // Meta event
                const metaType = this.data[this.pos++];
                const metaLength = this.readVLQ();

                if (metaType === 0x03) {
                    // Track name
                    track.name = this.readString(metaLength);
                } else if (metaType === 0x51) {
                    // Tempo change
                    const tempo = this.readInt(3);
                    this.tempoChanges.push({
                        tick: absoluteTick,
                        microsecondsPerQuarter: tempo
                    });
                } else if (metaType === 0x2F) {
                    // End of track
                    break;
                } else {
                    // Skip other meta events
                    this.pos += metaLength;
                }
            } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                // SysEx event - skip
                const length = this.readVLQ();
                this.pos += length;
            } else if (eventType === 0x90) {
                // Note On
                const note = this.data[this.pos++];
                const velocity = this.data[this.pos++];

                if (velocity > 0) {
                    // Real note-on: store for later pairing with note-off
                    const key = `${channel}-${note}`;
                    track.activeNotes[key] = {
                        startTick: absoluteTick,
                        note: note,
                        velocity: velocity,
                        channel: channel
                    };
                } else {
                    // Velocity 0 = note off
                    this.handleNoteOff(track, channel, note, absoluteTick);
                }
            } else if (eventType === 0x80) {
                // Note Off
                const note = this.data[this.pos++];
                this.pos++; // Skip velocity
                this.handleNoteOff(track, channel, note, absoluteTick);
            } else if (eventType === 0xA0) {
                // Polyphonic aftertouch - skip
                this.pos += 2;
            } else if (eventType === 0xB0) {
                // Control change - skip
                this.pos += 2;
            } else if (eventType === 0xC0) {
                // Program change - could use for instrument mapping later
                this.pos += 1;
            } else if (eventType === 0xD0) {
                // Channel aftertouch - skip
                this.pos += 1;
            } else if (eventType === 0xE0) {
                // Pitch bend - skip
                this.pos += 2;
            }
        }

        // Close any remaining active notes at track end
        for (const key in track.activeNotes) {
            const noteOn = track.activeNotes[key];
            track.notes.push({
                startTick: noteOn.startTick,
                endTick: absoluteTick,
                note: noteOn.note,
                velocity: noteOn.velocity,
                channel: noteOn.channel
            });
        }

        // Sort notes by start time
        track.notes.sort((a, b) => a.startTick - b.startTick);

        // Clean up
        delete track.activeNotes;

        return track;
    }

    handleNoteOff(track, channel, note, absoluteTick) {
        const key = `${channel}-${note}`;
        if (track.activeNotes[key]) {
            const noteOn = track.activeNotes[key];
            track.notes.push({
                startTick: noteOn.startTick,
                endTick: absoluteTick,
                note: noteOn.note,
                velocity: noteOn.velocity,
                channel: noteOn.channel
            });
            delete track.activeNotes[key];
        }
    }

    // Convert parsed MIDI to GameMaker music format
    // trackMap: array of track indices to use for GM channels [ch1Track, ch2Track, ch3Track]
    //   - If all 3 map to the same track, uses voice separation (polyphonic split)
    //   - Otherwise, each track maps to one channel (original behavior)
    // options: { quantize: 'eighth'|'sixteenth'|'32nd', tempo: number (GM tempo byte) }
    convertToGM(trackMap = [0, 1, 2], options = {}) {
        const quantize = options.quantize || 'sixteenth';
        const gmTempo = options.tempo || 80;
        const ticksPerBeat = this.ticksPerQuarter;

        // Quantization grid in ticks
        const quantizeGrids = {
            'eighth': ticksPerBeat / 2,
            'sixteenth': ticksPerBeat / 4,
            '32nd': ticksPerBeat / 8
        };
        const gridTicks = quantizeGrids[quantize] || quantizeGrids['sixteenth'];

        // Check if we should use voice separation (all channels from same track)
        const uniqueTracks = [...new Set(trackMap.filter(t => t >= 0))];
        const useVoiceSeparation = uniqueTracks.length === 1 || options.voiceSeparation;

        if (useVoiceSeparation) {
            return this.convertWithVoiceSeparation(uniqueTracks, gridTicks, ticksPerBeat, gmTempo);
        } else {
            return this.convertTrackPerChannel(trackMap, gridTicks, ticksPerBeat, gmTempo);
        }
    }

    // Voice separation: split polyphonic content into 3 voices by pitch
    // Channel 1 = highest notes (melody), Channel 2 = middle, Channel 3 = lowest (bass)
    convertWithVoiceSeparation(trackIndices, gridTicks, ticksPerBeat, gmTempo) {
        const gmDurations = this.getGMDurations();

        // Collect all notes from selected tracks
        let allNotes = [];
        for (const trackIndex of trackIndices) {
            const track = this.tracks[trackIndex];
            if (track) {
                allNotes = allNotes.concat(track.notes);
            }
        }

        if (allNotes.length === 0) {
            return { channels: [[], [], []], tempo: gmTempo, instruments: [7, 7, 1] };
        }

        // Quantize and convert to beats
        const quantizedNotes = allNotes.map(note => {
            const startBeat = this.ticksToBeats(this.quantizeTick(note.startTick, gridTicks), ticksPerBeat);
            let endBeat = this.ticksToBeats(this.quantizeTick(note.endTick, gridTicks), ticksPerBeat);
            // Ensure minimum duration of one grid unit to prevent "zombie" notes
            if (endBeat <= startBeat) {
                endBeat = startBeat + this.ticksToBeats(gridTicks, ticksPerBeat);
            }
            return {
                startBeat,
                endBeat,
                midiPitch: note.note,
                pitch: this.midiToGMPitch(note.note),
                velocity: note.velocity
            };
        }).filter(note => note.pitch >= 0 && note.pitch <= 60);

        // Build timeline of events (note starts and ends)
        const events = [];
        for (const note of quantizedNotes) {
            events.push({ beat: note.startBeat, type: 'start', note });
            events.push({ beat: note.endBeat, type: 'end', note });
        }
        events.sort((a, b) => a.beat - b.beat || (a.type === 'end' ? -1 : 1));

        // Process timeline, assigning notes to voices
        const activeNotes = new Set();
        const voiceAssignments = [[], [], []]; // What each voice plays over time
        let lastBeat = 0;

        // Group events by beat
        const beatEvents = new Map();
        for (const event of events) {
            const beatKey = event.beat.toFixed(6);
            if (!beatEvents.has(beatKey)) {
                beatEvents.set(beatKey, []);
            }
            beatEvents.get(beatKey).push(event);
        }

        // Process each beat
        for (const [beatKey, eventsAtBeat] of beatEvents) {
            const beat = parseFloat(beatKey);

            // Process all events at this beat
            for (const event of eventsAtBeat) {
                if (event.type === 'start') {
                    activeNotes.add(event.note);
                } else {
                    activeNotes.delete(event.note);
                }
            }

            // Assign active notes to voices by pitch (highest to lowest)
            const sortedActive = [...activeNotes].sort((a, b) => b.midiPitch - a.midiPitch);

            // Record state at this beat for each voice
            for (let voice = 0; voice < 3; voice++) {
                const note = sortedActive[voice] || null;
                voiceAssignments[voice].push({
                    beat,
                    note: note ? { ...note } : null
                });
            }
        }

        // Convert voice assignments to GM note sequences
        const gmChannels = [[], [], []];

        for (let voice = 0; voice < 3; voice++) {
            const assignments = voiceAssignments[voice];
            if (assignments.length === 0) continue;

            let currentBeat = 0;
            let currentNote = null;
            let noteStartBeat = 0;

            for (let i = 0; i < assignments.length; i++) {
                const { beat, note } = assignments[i];
                const nextBeat = (i + 1 < assignments.length) ? assignments[i + 1].beat : beat + 0.125;

                // Check if note changed
                const noteChanged = (currentNote?.midiPitch !== note?.midiPitch);

                if (noteChanged && currentNote !== null) {
                    // End current note
                    const duration = beat - noteStartBeat;
                    if (duration > 0.001) {
                        this.addNoteToChannel(gmChannels[voice], currentNote.pitch, noteStartBeat, duration, currentBeat, gmDurations);
                        currentBeat = noteStartBeat + duration;
                    }
                }

                if (noteChanged) {
                    // Fill gap with rest if needed
                    if (note === null && currentBeat < beat) {
                        const restDuration = beat - currentBeat;
                        const restNotes = this.createRestNotes(restDuration, gmDurations);
                        gmChannels[voice].push(...restNotes);
                        currentBeat = beat;
                    }

                    currentNote = note;
                    noteStartBeat = beat;
                }
            }

            // End final note
            if (currentNote !== null) {
                const lastAssign = assignments[assignments.length - 1];
                const finalDuration = Math.max(0.125, lastAssign.beat - noteStartBeat + 0.25);
                this.addNoteToChannel(gmChannels[voice], currentNote.pitch, noteStartBeat, finalDuration, currentBeat, gmDurations);
            }
        }

        return {
            channels: gmChannels,
            tempo: gmTempo,
            instruments: [7, 7, 1] // Piano for melody/harmony, bass for bass
        };
    }

    // Original behavior: one track per channel
    convertTrackPerChannel(trackMap, gridTicks, ticksPerBeat, gmTempo) {
        const gmDurations = this.getGMDurations();
        const gmChannels = [[], [], []];

        for (let ch = 0; ch < 3; ch++) {
            const trackIndex = trackMap[ch];
            if (trackIndex === undefined || trackIndex === null || trackIndex < 0) {
                continue;
            }

            const track = this.tracks[trackIndex];
            if (!track || track.notes.length === 0) {
                continue;
            }

            // Quantize note start/end times and convert to beats
            const quantizedNotes = track.notes.map(note => ({
                startBeat: this.ticksToBeats(this.quantizeTick(note.startTick, gridTicks), ticksPerBeat),
                endBeat: this.ticksToBeats(this.quantizeTick(note.endTick, gridTicks), ticksPerBeat),
                pitch: this.midiToGMPitch(note.note),
                velocity: note.velocity
            })).filter(note => note.pitch >= 0 && note.pitch <= 60);

            // Sort by start time, then by pitch (highest first for melody preference)
            quantizedNotes.sort((a, b) => a.startBeat - b.startBeat || b.pitch - a.pitch);

            let currentBeat = 0;

            for (const note of quantizedNotes) {
                if (note.startBeat < currentBeat - 0.001) {
                    continue; // Skip overlapping notes
                }

                // Insert rest if there's a gap
                if (note.startBeat > currentBeat + 0.001) {
                    const gapBeats = note.startBeat - currentBeat;
                    const restNotes = this.createRestNotes(gapBeats, gmDurations);
                    gmChannels[ch].push(...restNotes);
                    currentBeat = note.startBeat;
                }

                // Add the note
                let noteBeats = Math.max(note.endBeat - note.startBeat, 0.125);
                while (noteBeats > 0.001) {
                    const dur = this.findBestDuration(noteBeats, gmDurations);
                    const isTied = noteBeats > dur.beats + 0.001;

                    gmChannels[ch].push({
                        durationByte: dur.byte | (isTied ? 0x20 : 0),
                        pitch: note.pitch,
                        isRest: false,
                        isTied: isTied,
                        duration: dur.beats
                    });

                    noteBeats -= dur.beats;
                    currentBeat += dur.beats;
                }
            }
        }

        return {
            channels: gmChannels,
            tempo: gmTempo,
            instruments: [7, 12, 1]
        };
    }

    // Helper: add a note to a channel, handling ties for long notes
    addNoteToChannel(channel, pitch, startBeat, duration, currentBeat, gmDurations) {
        // Fill gap with rest if needed
        if (startBeat > currentBeat + 0.001) {
            const restNotes = this.createRestNotes(startBeat - currentBeat, gmDurations);
            channel.push(...restNotes);
        }

        // Add note, breaking into ties if needed
        let remaining = duration;
        while (remaining > 0.001) {
            const dur = this.findBestDuration(remaining, gmDurations);
            const isTied = remaining > dur.beats + 0.001;

            channel.push({
                durationByte: dur.byte | (isTied ? 0x20 : 0),
                pitch: pitch,
                isRest: false,
                isTied: isTied,
                duration: dur.beats
            });

            remaining -= dur.beats;
        }
    }

    // Helper functions
    getGMDurations() {
        return [
            { byte: 0x1F, beats: 4.0, name: 'whole' },
            { byte: 0x17, beats: 3.0, name: 'dotted-half' },
            { byte: 0x0F, beats: 2.0, name: 'half' },
            { byte: 0x0B, beats: 1.5, name: 'dotted-quarter' },
            { byte: 0x07, beats: 1.0, name: 'quarter' },
            { byte: 0x05, beats: 0.75, name: 'dotted-eighth' },
            { byte: 0x03, beats: 0.5, name: 'eighth' },
            { byte: 0x01, beats: 0.25, name: 'sixteenth' },
            { byte: 0x00, beats: 0.125, name: '32nd' }
        ];
    }

    midiToGMPitch(midiNote) {
        return midiNote - 31;
    }

    findBestDuration(beats, gmDurations) {
        for (const dur of gmDurations) {
            if (dur.beats <= beats + 0.001) {
                return dur;
            }
        }
        return gmDurations[gmDurations.length - 1];
    }

    quantizeTick(tick, gridTicks) {
        return Math.round(tick / gridTicks) * gridTicks;
    }

    ticksToBeats(ticks, ticksPerBeat) {
        return ticks / ticksPerBeat;
    }

    // Create rest notes to fill a gap
    createRestNotes(gapBeats, gmDurations) {
        const rests = [];
        let remaining = gapBeats;

        while (remaining > 0.001) {
            // Find largest rest that fits
            let dur = gmDurations[gmDurations.length - 1]; // Start with 32nd
            for (const d of gmDurations) {
                // Skip dotted durations for rests (GM doesn't have dotted rests)
                if ([0x05, 0x0B, 0x17].includes(d.byte)) continue;
                if (d.beats <= remaining + 0.001) {
                    dur = d;
                    break;
                }
            }

            rests.push({
                durationByte: dur.byte | 0x40, // Rest flag
                pitch: 0x3C, // Middle C (hidden rest marker)
                isRest: true,
                isTied: false,
                duration: dur.beats
            });

            remaining -= dur.beats;
        }

        return rests;
    }

    // Get track info for UI display
    getTrackInfo() {
        return this.tracks.map((track, index) => ({
            index: index,
            name: track.name || `Track ${index + 1}`,
            noteCount: track.notes.length,
            hasNotes: track.notes.length > 0,
            // Get pitch range
            minNote: track.notes.length > 0 ? Math.min(...track.notes.map(n => n.note)) : 0,
            maxNote: track.notes.length > 0 ? Math.max(...track.notes.map(n => n.note)) : 0,
            // Get duration in ticks
            duration: track.notes.length > 0 ? Math.max(...track.notes.map(n => n.endTick)) : 0
        }));
    }

    // Convert MIDI note number to note name for display
    static midiNoteToName(note) {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(note / 12) - 1;
        const name = names[note % 12];
        return name + octave;
    }
}

// =============================================================================
// MIDI EXPORT
// =============================================================================

class MidiExport {
    // GM instrument mappings to General MIDI program numbers (1-128)
    // Two options: acoustic (realistic) and synth (electronic)
    static INSTRUMENT_MAP = {
        acoustic: {
            0:  1,    // off → Acoustic Grand Piano
            1:  33,   // bass → Acoustic Bass
            2:  115,  // cow bell → Steel Drums (closest percussion-like)
            3:  1,    // cymbal → (use drum channel instead)
            4:  74,   // flute → Flute
            5:  25,   // guitar → Acoustic Guitar (nylon)
            6:  7,    // harpsichord → Harpsichord
            7:  1,    // piano → Acoustic Grand Piano
            8:  66,   // saxophone → Alto Sax
            9:  1,    // snare → (use drum channel instead)
            10: 81,   // synthesizer → Lead 1 (square)
            11: 57,   // trumpet → Trumpet
            12: 41,   // violin → Violin
            13: 14    // xylophone → Xylophone
        },
        synth: {
            0:  81,   // off → Lead 1 (square) - matches GM's triangle-ish
            1:  39,   // bass → Synth Bass 1
            2:  115,  // cow bell → Steel Drums
            3:  1,    // cymbal → (use drum channel)
            4:  80,   // flute → Lead 8 (bass + lead) - softer synth
            5:  28,   // guitar → Electric Guitar (clean)
            6:  7,    // harpsichord → Harpsichord (no synth equivalent)
            7:  5,    // piano → Electric Piano 1
            8:  87,   // saxophone → Lead 7 (fifths)
            9:  1,    // snare → (use drum channel)
            10: 82,   // synthesizer → Lead 2 (sawtooth)
            11: 83,   // trumpet → Lead 3 (calliope)
            12: 51,   // violin → Synth Strings 1
            13: 12    // xylophone → Vibraphone
        }
    };

    // Export gmMusic to MIDI file bytes
    static export(song, options = {}) {
        const mapping = options.mapping || 'acoustic';
        const instrumentMap = this.INSTRUMENT_MAP[mapping] || this.INSTRUMENT_MAP.acoustic;

        // MIDI timing: use 480 ticks per quarter note (standard)
        const ticksPerQuarter = 480;

        // Calculate ticks per beat from GM tempo
        // GM tempo 80 = 140 BPM, scales linearly
        const bpm = (song.tempo / 80) * 140;
        const microsecondsPerQuarter = Math.round(60000000 / bpm);

        // Build tracks
        const tracks = [];

        // Track 0: Tempo track (meta events only)
        const tempoTrack = this.buildTempoTrack(microsecondsPerQuarter, song.name);
        tracks.push(tempoTrack);

        // Tracks 1-3: Note data for each channel
        for (let ch = 0; ch < 3; ch++) {
            const midiChannel = ch; // MIDI channels 0, 1, 2
            const gmInstrument = song.instruments[ch];
            const midiProgram = instrumentMap[gmInstrument] || 1;

            const noteTrack = this.buildNoteTrack(
                song.channels[ch],
                midiChannel,
                midiProgram - 1, // MIDI uses 0-127
                ticksPerQuarter
            );
            tracks.push(noteTrack);
        }

        // Assemble complete MIDI file
        return this.assembleMidiFile(tracks, ticksPerQuarter);
    }

    static buildTempoTrack(microsecondsPerQuarter, songName) {
        const events = [];

        // Track name meta event
        const nameBytes = this.stringToBytes(songName.trim() || 'GMC64 Export');
        events.push({
            delta: 0,
            data: [0xFF, 0x03, ...this.writeVLQ(nameBytes.length), ...nameBytes]
        });

        // Tempo meta event
        events.push({
            delta: 0,
            data: [
                0xFF, 0x51, 0x03,
                (microsecondsPerQuarter >> 16) & 0xFF,
                (microsecondsPerQuarter >> 8) & 0xFF,
                microsecondsPerQuarter & 0xFF
            ]
        });

        // Time signature: 4/4
        events.push({
            delta: 0,
            data: [0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]
        });

        // End of track
        events.push({
            delta: 0,
            data: [0xFF, 0x2F, 0x00]
        });

        return this.eventsToTrackBytes(events);
    }

    static buildNoteTrack(notes, midiChannel, midiProgram, ticksPerQuarter) {
        const events = [];

        // Program change at start
        events.push({
            delta: 0,
            data: [0xC0 | midiChannel, midiProgram]
        });

        // Convert notes to MIDI events
        let currentTick = 0;

        for (const note of notes) {
            if (note.isRest) {
                // Rests just advance time
                currentTick += Math.round(note.duration * ticksPerQuarter);
                continue;
            }

            // Convert GM pitch to MIDI note number
            // GM pitch 0x26 (38) = A4 = MIDI 69
            // So MIDI note = GM pitch + 31
            const midiNote = note.pitch + 31;

            // Clamp to valid MIDI range
            if (midiNote < 0 || midiNote > 127) continue;

            const velocity = 80; // Default velocity
            const durationTicks = Math.round(note.duration * ticksPerQuarter);

            // Note On
            events.push({
                absoluteTick: currentTick,
                data: [0x90 | midiChannel, midiNote, velocity]
            });

            // Note Off (at end of duration)
            // For tied notes, use 95% of duration to create legato
            const offTick = currentTick + Math.round(durationTicks * (note.isTied ? 0.95 : 0.8));
            events.push({
                absoluteTick: offTick,
                data: [0x80 | midiChannel, midiNote, 0]
            });

            currentTick += durationTicks;
        }

        // Sort events by absolute tick
        events.sort((a, b) => (a.absoluteTick || 0) - (b.absoluteTick || 0));

        // Convert absolute ticks to delta times
        let lastTick = 0;
        for (const event of events) {
            if (event.absoluteTick !== undefined) {
                event.delta = event.absoluteTick - lastTick;
                lastTick = event.absoluteTick;
            }
        }

        // End of track
        events.push({
            delta: 0,
            data: [0xFF, 0x2F, 0x00]
        });

        return this.eventsToTrackBytes(events);
    }

    static eventsToTrackBytes(events) {
        const bytes = [];

        for (const event of events) {
            // Write delta time as VLQ
            bytes.push(...this.writeVLQ(event.delta || 0));
            // Write event data
            bytes.push(...event.data);
        }

        return bytes;
    }

    static assembleMidiFile(tracks, ticksPerQuarter) {
        const bytes = [];

        // Header chunk: MThd
        bytes.push(0x4D, 0x54, 0x68, 0x64); // "MThd"
        bytes.push(0x00, 0x00, 0x00, 0x06); // Header length: 6
        bytes.push(0x00, 0x01);             // Format: 1 (multi-track)
        bytes.push((tracks.length >> 8) & 0xFF, tracks.length & 0xFF); // Number of tracks
        bytes.push((ticksPerQuarter >> 8) & 0xFF, ticksPerQuarter & 0xFF); // Ticks per quarter

        // Track chunks
        for (const trackData of tracks) {
            bytes.push(0x4D, 0x54, 0x72, 0x6B); // "MTrk"
            const len = trackData.length;
            bytes.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
            bytes.push(...trackData);
        }

        return new Uint8Array(bytes);
    }

    // Write variable-length quantity
    static writeVLQ(value) {
        if (value < 0) value = 0;

        const bytes = [];
        bytes.push(value & 0x7F);
        value >>= 7;

        while (value > 0) {
            bytes.unshift((value & 0x7F) | 0x80);
            value >>= 7;
        }

        return bytes;
    }

    static stringToBytes(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            bytes.push(str.charCodeAt(i) & 0x7F);
        }
        return bytes;
    }
}

// Make available globally
if (typeof globalThis !== 'undefined') {
    globalThis.MidiImport = MidiImport;
    globalThis.MidiExport = MidiExport;
}
