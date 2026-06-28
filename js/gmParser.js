// gmParser.js — GMC64 program parser
//
// Parses program files into executable structures:
// - parseProgramData: Extracts instructions, labels, and mediaStore from raw file bytes
// - serializeProgram: Converts parsed data back to raw PRG file bytes
// - buildAST: Converts flat instruction list into nested AST with if/then/else structure
//
// === MEDIA STORE AND SPRITE INSTANCES ===
// The media store (JS array) holds parsed sprite/scene data along with raw file bytes.
// For sprites, we store BOTH:
//   - sprite: A pre-parsed gmSprite instance (used for data comparison)
//   - spriteFileData: Raw bytes (used to create new instances per slot)
//
// Why store both? The runtime creates a NEW gmSprite instance for each sprite
// slot assignment ("sprite X is name"). This allows each slot to have independent
// colors, matching real C64 hardware behavior. The raw spriteFileData enables
// this on-demand instantiation without re-parsing from scratch.
//
// === MULTI-PART SPRITES (CRITICAL DESIGN PATTERN) ===
//
// GameMaker supports "multi-part" sprites combining up to 4 C64 hardware sprites.
//
// TWO ENTRY POINTS exist for loading sprites, both normalizing to the same structure:
//
//   1. DISK-LOADED (editor.html): User picks .SPR file from disk
//      - .SPR files are already contiguous (all quads in one file)
//      - Just pass entire file to gmSprite, create empty markers
//
//   2. PRG-LOADED (this file): Parsing embedded sprite data from binary data page
//      - PRG files store each quad as a SEPARATE binary entry
//      - Must concatenate data from consecutive entries before parsing
//      - Then create gmSprite from concatenated buffer, mark indices as empty
//
// The code is intentionally NOT deduplicated - input formats are fundamentally different.
//
// NORMALIZED STRUCTURE (same for both entry points):
//   mediaStore[N]:   { sprite: gmSprite, quadIndex: 0 }              // MAIN - has all quads
//   mediaStore[N+1]: { sprite: null, quadIndex: 1 }  // EMPTY marker
//   mediaStore[N+2]: { sprite: null, quadIndex: 2 }  // EMPTY marker
//   mediaStore[N+3]: { sprite: null, quadIndex: 3 }  // EMPTY marker
//
// A marker is identified by quadIndex > 0 (the main entry has quadIndex: 0).
//
// Markers exist only for pointer table indexing. At runtime they are no-ops.
//
// PRG PARSING FLOW (this file):
//   1. Peek at header byte 14 to get numSprites
//   2. If numSprites > 1, collect data from consecutive pointer table entries
//   3. Concatenate into one buffer, pass to new gmSprite()
//   4. Mark subsprite indices so they become empty markers when encountered
//
// SERIALIZING: Extract each quad from main's gmSprite, write to marker pointers.
//
// See CLAUDE.md "Multi-Part Sprites" section for full documentation.
//
// Dependencies (must be loaded before this file):
// - c64lib.js (decodeString)
// - gmOpcodes.js (gmOpcodes, formatInstruction, c64ColorNames)
// - gmSprite.js (gmSprite class)
// - gmScene.js (gmScene class)
// - d64lib.js (loadFileByName for scene files)
//
// =============================================================================
// SOURCE OF TRUTH LIFECYCLE
// =============================================================================
//
// LOADING (PRG file → in-memory structures):
//   1. PRG file (with its binary data page) is the source of truth
//   2. parseProgramData() extracts: instructions (AST), mediaStore (JS objects)
//   3. After parsing, AST + mediaStore become the source of truth
//   4. Original PRG binary is no longer needed
//
// EDITING (in-memory):
//   - AST: User edits instructions via editor UI
//   - Media store: User assigns sprites/sounds via editor UI
//   - Both are modified independently
//
// SAVING (in-memory structures → PRG file):
//   1. AST + media store are the source of truth
//   2. serializeProgram() walks AST to find referenced media
//   3. Fresh binary data page is BUILT (output, not input)
//   4. Compact pointer table assigned (no gaps)
//   5. Result is a new PRG file
//
// =============================================================================

// Decode a 16-bit little-endian value from two bytes
// Used throughout GameMaker file format parsing
function decode16bit(lowByte, highByte) {
    return lowByte + (highByte * 256);
}

// Is this mediaStore entry a multi-part sprite marker (i.e. quad 1/2/3,
// not the main entry)? Single source of truth for the marker convention —
// use this everywhere rather than inlining `quadIndex > 0` so the semantic
// is explicit at the call site.
function isMarkerEntry(entry) {
    return !!entry && (entry.quadIndex || 0) > 0;
}

// Parse program from file data
// Returns: { instructions, labelMap, mediaStore, dataTables, missingScenes }
// - instructions: Array of instruction objects with opcode, args, and formatted names
// - labelMap: Maps label numbers to instruction indices
// - mediaStore: JS array of media entries (sprites, scenes, songs, sounds) indexed by reference number
// - dataTables: Maps label numbers to arrays of data values
// - missingScenes: Array of { index, name, fileName } for scenes that couldn't be loaded
function parseProgramData(fileData) {
    const PROGRAM_START = 523;
    const PROGRAM_END = 514 + decode16bit(fileData[514], (fileData[515] - 6));
    const DATA_START = PROGRAM_END;
    const OFFSET = 0x3D90;
    const DATA_END = OFFSET - decode16bit(fileData[516], fileData[517]);

    // Helper function to read a specific pointer table entry on-demand
    // Note: index is the "compacted" index (skipping OFFSET entries), not raw byte position
    function getPointerForIndex(index) {
        let currentIndex = 0;

        for (let i = -81; i > -256; i -= 2) {
            const lowByte = fileData.at(i);
            const highByte = fileData.at(i + 1);
            const rawAddr = decode16bit(lowByte, highByte);

            if (rawAddr === 0) break; // End of table
            if (rawAddr === OFFSET) continue; // Skip sentinel, don't increment index

            currentIndex++;

            if (currentIndex === index) {
                const dataPointer = OFFSET - rawAddr;
                const dataStart = (PROGRAM_END + DATA_END) - dataPointer;

                return {
                    rawAddr: rawAddr,
                    ptr: dataStart
                };
            }
        }

        return null; // Index not found
    }

    // Parse instructions and find which data page indices are referenced
    const instructions = [];
    const labelMap = {};
    const referencedDataIndices = new Set();
    const mediaTypes = {}; // Track what type each index is (sprite, scene, song, sound)
    const missingScenes = [];  // Track scenes that couldn't be loaded from disk
    const spriteAssignments = [];  // Track "sprite X is Y" instructions for multi-part pairing

    // Data tables: maps label number -> array of values
    // Built from "data values" instructions (0x1D) that follow a label
    const dataTables = {};
    let currentDataLabel = null; // Track which label we're accumulating data for

    for (let i = PROGRAM_START; i < PROGRAM_END; i += 4) {
        const label = fileData[i];
        const arg1 = fileData[i + 1];
        const opcode = fileData[i + 2];
        const arg2 = fileData[i + 3];

        if (label > 0) {
            labelMap[label] = instructions.length;
            // Start a new data table accumulator for this label
            currentDataLabel = label;
        }

        // Accumulate data values into dataTables
        // Each "data values" instruction (0x1D) stores 2 values (arg1 and arg2)
        if (opcode === 0x1D) {
            if (currentDataLabel !== null) {
                if (!dataTables[currentDataLabel]) {
                    dataTables[currentDataLabel] = [];
                }
                dataTables[currentDataLabel].push(arg1, arg2);
            }
        } else {
            // Non-data instruction ends accumulation for this label
            // (but we keep currentDataLabel in case next instruction has a new label)
        }

        // Track data page references and their types
        if (opcode === 0x27) { // sprite is [dataIndex]
            referencedDataIndices.add(arg2);
            mediaTypes[arg2] = 'sprite';
        } else if (opcode === 0x28) { // scene is [dataIndex]
            referencedDataIndices.add(arg2);
            mediaTypes[arg2] = 'scene';
        } else if (opcode === 0x60) { // song is [dataIndex]
            referencedDataIndices.add(arg2);
            mediaTypes[arg2] = 'song';
        } else if (opcode === 0x40) { // sound channel X = [dataIndex]
            referencedDataIndices.add(arg2);
            mediaTypes[arg2] = 'sound';
        }

        // Track sprite slot assignments to detect multi-part sprite pairings
        // When "sprite 1 is X" is immediately followed by "sprite 2 is Y",
        // and X is a main sprite (spriteNum=1) and Y is a subsprite (spriteNum>1),
        // then Y is the subsprite for X.
        // We store the instruction index to update args later.
        if (opcode === 0x27) {
            spriteAssignments.push({
                instrIndex: instructions.length,  // Will be pushed after this
                slotNum: arg1 + 1,  // arg1 is 0-indexed slot
                prgIndex: arg2      // PRG data page index
            });
        }

        // Format instruction name (will update after loading data page for special opcodes)
        const op = gmOpcodes[opcode];
        let instructionName = op ? formatInstruction(opcode, arg1, arg2, null, c64ColorNames) : 'UNKNOWN';
        var printBytes = undefined;

        // Special handling for opcodes that need data page lookups
        if (opcode === 0x2B) { // comment
            const cmtPointer = OFFSET - decode16bit(arg1, arg2);
            const cmtStart = (PROGRAM_END + DATA_END) - cmtPointer;
            const cmtData = fileData.slice(cmtStart, cmtStart + 25);
            instructionName = `/ ${decodeString(cmtData)}`;
        } else if (opcode === 0x3B) { // print string
            const printPointer = OFFSET - decode16bit(arg1, arg2);
            const printStart = (PROGRAM_END + DATA_END) - printPointer;
            const printData = fileData.slice(printStart, printStart + 20);
            // Store raw bytes for VM execution - GM indices map directly to charset
            printBytes = Array.from(printData);
            // Decode for display in listing
            instructionName = `print ${decodeString(printData)}`;
        }

        const instrObj = {
            label,
            arg1,
            opcode,
            arg2,
            instructionName
        };
        // Add printBytes for 0x3B opcode (print literal string)
        if (opcode === 0x3B && printBytes !== undefined) {
            instrObj.printBytes = printBytes;
        }
        instructions.push(instrObj);
    }

    // Now parse only the referenced data page entries
    const sortedIndices = Array.from(referencedDataIndices).sort((a,b) => a-b);

    // Calculate actual data sizes for each entry by reading ALL pointer entries
    // and computing gaps between them.
    const allPointerEntries = [];
    for (let i = -81; i > -256; i -= 2) {
        const lowByte = fileData.at(i);
        const highByte = fileData.at(i + 1);
        const rawAddr = decode16bit(lowByte, highByte);

        if (rawAddr === 0) break; // End of table
        if (rawAddr === OFFSET) continue; // Skip sentinel
        if (rawAddr === 0x00be) continue; // Skip spacer

        const dataPointer = OFFSET - rawAddr;
        const dataStart = (PROGRAM_END + DATA_END) - dataPointer;
        allPointerEntries.push({ rawAddr, dataStart });
    }

    // Sort by dataStart position to calculate gaps
    allPointerEntries.sort((a, b) => a.dataStart - b.dataStart);

    // Calculate actual size for each entry based on gap to next entry
    const dataEndPosition = PROGRAM_END + DATA_END;
    const actualSizeByDataStart = {};
    for (let i = 0; i < allPointerEntries.length; i++) {
        const entry = allPointerEntries[i];
        const nextEntry = allPointerEntries[i + 1];
        const actualSize = nextEntry
            ? nextEntry.dataStart - entry.dataStart
            : dataEndPosition - entry.dataStart;
        actualSizeByDataStart[entry.dataStart] = actualSize;
    }

    // === PHASE 1: Collect raw sprite data from all referenced entries ===
    // For each referenced sprite PRG index, get its data location, name, and header info
    const rawSpriteData = {};  // prgIndex -> { dataStart, size, name, spriteNum, numSprites }
    for (const idx of sortedIndices) {
        if (mediaTypes[idx] !== 'sprite') continue;

        const pointerInfo = getPointerForIndex(idx);
        if (!pointerInfo) continue;

        const dataStart = pointerInfo.ptr;
        const size = actualSizeByDataStart[dataStart] || 0;
        const name = decodeString(fileData.slice(dataStart, dataStart + 6));
        const spriteNum = (fileData[dataStart + 22] || 0) + 1;  // Which quad (1=main, 2-4=sub)
        const numSprites = (fileData[dataStart + 14] & 0x03) + 1;  // Total quads in multi-part

        rawSpriteData[idx] = { dataStart, size, name, spriteNum, numSprites };
    }

    // === PHASE 2: Analyze instruction order to find multi-part sprite pairings ===
    // Look for patterns: "sprite N is X" followed by "sprite N+1 is Y", "sprite N+2 is Z", etc.
    // where X is a main sprite (spriteNum=1, numSprites>1) and Y,Z are subsprites (spriteNum>1)
    // Multi-part sprites can be assigned to ANY slot, not just slot 1.
    const spritePairings = {};  // mainPrgIndex -> [subPrgIndex1, subPrgIndex2, ...]
    const subspriteToMain = {}; // subPrgIndex -> mainPrgIndex (for lookup)
    const pairedQuads = {};     // mainPrgIndex -> { quadIndex -> firstSubPrgIndex }
    const duplicateSubsprites = {};  // duplicatePrgIndex -> firstPrgIndex (for mapping duplicates)

    for (let i = 0; i < spriteAssignments.length; i++) {
        const curr = spriteAssignments[i];
        const mainData = rawSpriteData[curr.prgIndex];

        // Check if this is an assignment to a multi-part main sprite (any slot)
        if (mainData && mainData.spriteNum === 1 && mainData.numSprites > 1) {

            // Look at the next numSprites-1 assignments for subsprites
            const numSubsprites = mainData.numSprites - 1;

            for (let j = 1; j <= numSubsprites && i + j < spriteAssignments.length; j++) {
                const sub = spriteAssignments[i + j];
                const subData = rawSpriteData[sub.prgIndex];

                // Subsprite should be assigned to consecutive slot (curr.slotNum + j)
                // and be a subsprite (spriteNum > 1)
                if (sub.slotNum === curr.slotNum + j && subData && subData.spriteNum > 1) {
                    // Get the quad index from spriteNum (spriteNum is 1-indexed, quad is 0-indexed)
                    const quadIndex = subData.spriteNum - 1;

                    // Initialize tracking structures if needed
                    if (!spritePairings[curr.prgIndex]) {
                        spritePairings[curr.prgIndex] = [];
                        pairedQuads[curr.prgIndex] = {};
                    }

                    // Only add if this quad hasn't been paired yet (avoid duplicates from same sprite
                    // appearing multiple times in data page when referenced multiple times in code)
                    if (pairedQuads[curr.prgIndex][quadIndex] === undefined) {
                        spritePairings[curr.prgIndex].push(sub.prgIndex);
                        subspriteToMain[sub.prgIndex] = curr.prgIndex;
                        pairedQuads[curr.prgIndex][quadIndex] = sub.prgIndex;
                    } else {
                        // Record this as a duplicate that should map to the first one
                        duplicateSubsprites[sub.prgIndex] = pairedQuads[curr.prgIndex][quadIndex];
                        subspriteToMain[sub.prgIndex] = curr.prgIndex;  // Still mark as subsprite
                    }
                }
            }
        }
    }

    // === PHASE 3: Compose multi-part sprites and build clean mediaStore ===
    // Each unique main sprite (with its subs) becomes one mediaStore entry
    // Single sprites also get their own entries
    // Subsprites become marker entries pointing to their main
    const prgToMediaIndex = {};  // Map from PRG index to new mediaStore index
    let mediaStore = [null];     // Index 0 is unused
    let nextMediaIndex = 1;

    // Process all referenced sprites
    for (const idx of sortedIndices) {
        if (mediaTypes[idx] !== 'sprite') continue;

        const data = rawSpriteData[idx];
        if (!data) continue;

        // Skip if this is a subsprite - it will be processed with its main sprite
        if (subspriteToMain[idx] !== undefined) continue;

        // Check if this is a main sprite with subsprites
        const subIndices = spritePairings[idx] || [];

        if (subIndices.length > 0) {
            // Multi-part sprite: compose main + subs into one gmSprite

            // Sort subsprites by their quad index (spriteNum) to ensure correct order
            const sortedSubIndices = [...subIndices].sort((a, b) => {
                const aNum = rawSpriteData[a]?.spriteNum || 0;
                const bNum = rawSpriteData[b]?.spriteNum || 0;
                return aNum - bNum;
            });

            const chunks = [];
            // Main sprite: include 5-byte prefix to simulate magic header for gmSprite
            chunks.push(fileData.slice(data.dataStart - 5, data.dataStart + data.size));

            for (const subIdx of sortedSubIndices) {
                const subData = rawSpriteData[subIdx];
                if (subData) {
                    // Subsprite data (no magic prefix - subheader format)
                    chunks.push(fileData.slice(subData.dataStart, subData.dataStart + subData.size));
                }
            }

            // Concatenate into one buffer
            const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const spriteFileData = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of chunks) {
                spriteFileData.set(chunk, offset);
                offset += chunk.length;
            }

            // Create gmSprite and add to mediaStore.
            //
            // INVARIANT: entry.name is always exactly 6 chars (space-padded
            // GM convention). decodeString reads exactly 6 bytes; we keep it
            // as-is rather than trimming. Disk-filename construction
            // (`entry.name + '/PIC'`) then "just works" with no re-padding.
            // The only places that should trim are display contexts where
            // trailing whitespace genuinely matters visually (the editor's
            // UI handles this internally; most monospace renders are fine).
            const spriteInstance = new gmSprite(spriteFileData);
            const mediaIdx = nextMediaIndex++;
            mediaStore[mediaIdx] = {
                name: data.name,
                type: 'sprite',
                sprite: spriteInstance,
                spriteFileData: spriteFileData,
                quadIndex: 0
            };
            prgToMediaIndex[idx] = mediaIdx;

            // Create marker entries for subsprites (using sorted order).
            // Markers are identified by quadIndex > 0 — they have no sprite
            // or spriteFileData of their own; the main entry owns all quads.
            for (const subIdx of sortedSubIndices) {
                const subData = rawSpriteData[subIdx];
                // Use actual quad index from header (spriteNum is 1-indexed)
                const actualQuadIndex = subData ? subData.spriteNum - 1 : 0;
                const subMediaIdx = nextMediaIndex++;
                mediaStore[subMediaIdx] = {
                    name: subData ? subData.name : '      ',
                    type: 'sprite',
                    sprite: null,           // Markers have no sprite data
                    spriteFileData: null,
                    quadIndex: actualQuadIndex,
                    parentMediaIndex: mediaIdx  // Link to main sprite
                };
                prgToMediaIndex[subIdx] = subMediaIdx;
            }
        } else {
            // Single sprite (no subsprites)
            const spriteFileData = fileData.slice(data.dataStart - 5, data.dataStart + data.size);
            const spriteInstance = new gmSprite(spriteFileData);
            const mediaIdx = nextMediaIndex++;
            mediaStore[mediaIdx] = {
                name: data.name,
                type: 'sprite',
                sprite: spriteInstance,
                spriteFileData: spriteFileData,
                quadIndex: 0
            };
            prgToMediaIndex[idx] = mediaIdx;
        }
    }

    // Map duplicate subsprites to the same marker as their "first" counterpart
    for (const [dupIdx, firstIdx] of Object.entries(duplicateSubsprites)) {
        const firstMediaIdx = prgToMediaIndex[firstIdx];
        if (firstMediaIdx !== undefined) {
            prgToMediaIndex[dupIdx] = firstMediaIdx;
        }
    }

    // === PHASE 4: Update instruction args to use new mediaStore indices ===
    for (const instr of instructions) {
        if (instr.opcode === 0x27) {  // sprite is
            const oldIdx = instr.arg2;
            const newIdx = prgToMediaIndex[oldIdx];
            if (newIdx !== undefined) {
                instr.arg2 = newIdx;
            }
        }
    }

    // Also update spriteAssignments for any code that might use them
    for (const assign of spriteAssignments) {
        const newIdx = prgToMediaIndex[assign.prgIndex];
        if (newIdx !== undefined) {
            assign.prgIndex = newIdx;
        }
    }


    // === Continue with non-sprite media types ===
    for (let idx of sortedIndices) {
        const entryType = mediaTypes[idx] || 'unknown';
        if (entryType === 'sprite') continue;  // Already handled above

        const pointerInfo = getPointerForIndex(idx);
        if (!pointerInfo) {
            continue;
        }

        const dataStart = pointerInfo.ptr;
        const name = decodeString(fileData.slice(dataStart, dataStart + 6));

        let sceneData = null;
        let soundFileData = null;
        let songFileData = null;

        const mediaIdx = nextMediaIndex++;

        if (entryType === 'scene') {
            // Load as scene (.PIC file from D64, using gmScene for 320×200 native resolution)
            const baseName = name.toUpperCase();
            const picFileName = baseName + "/PIC";
            const picFileData = loadFileByName(picFileName);

            if (picFileData) {
                try {
                    sceneData = new gmScene(picFileData);
                } catch (sceneError) {
                }
            } else {
                // missingScenes is a user-facing display structure; trim
                // here so error messages don't show ragged-edge whitespace.
                missingScenes.push({ index: mediaIdx, name: name.trim(), fileName: picFileName });
                sceneData = gmScene.createBlank(0, 0, 0, 0);  // All black
            }
            // mediaStore.name preserves the 6-char padded form (invariant).
            mediaStore[mediaIdx] = { name: name, type: 'scene', scene: sceneData };
            prgToMediaIndex[idx] = mediaIdx;

        } else if (entryType === 'song') {
            try {
                songFileData = fileData.slice(dataStart - 5);
            } catch (e) {
            }
            mediaStore[mediaIdx] = { name: name, type: 'song', songFileData: songFileData };
            prgToMediaIndex[idx] = mediaIdx;

        } else if (entryType === 'sound') {
            try {
                soundFileData = fileData.slice(dataStart - 5);
            } catch (e) {
            }
            mediaStore[mediaIdx] = { name: name, type: 'sound', soundFileData: soundFileData };
            prgToMediaIndex[idx] = mediaIdx;

        } else {
            mediaStore[mediaIdx] = { name: name, type: 'unknown' };
            prgToMediaIndex[idx] = mediaIdx;
        }
    }

    // Update instruction args for non-sprite media types (scene, song, sound)
    for (const instr of instructions) {
        if (instr.opcode === 0x28) {  // scene is
            const oldIdx = instr.arg2;
            const newIdx = prgToMediaIndex[oldIdx];
            if (newIdx !== undefined) instr.arg2 = newIdx;
        } else if (instr.opcode === 0x60) {  // song is
            const oldIdx = instr.arg2;
            const newIdx = prgToMediaIndex[oldIdx];
            if (newIdx !== undefined) instr.arg2 = newIdx;
        } else if (instr.opcode === 0x40) {  // sound channel X =
            const oldIdx = instr.arg2;
            const newIdx = prgToMediaIndex[oldIdx];
            if (newIdx !== undefined) instr.arg2 = newIdx;
        }
    }

    // Update instruction names now that we have mediaStore
    // Re-format instructions that need mediaStore for name resolution
    for (let instr of instructions) {
        const opcode = instr.opcode;
        // Skip already-handled special cases (comment, print string)
        if (opcode === 0x2B || opcode === 0x3B) continue;
        // Re-format with mediaStore for name resolution
        instr.instructionName = formatInstruction(opcode, instr.arg1, instr.arg2, mediaStore, c64ColorNames);
    }

    return { instructions, labelMap, mediaStore, dataTables, missingScenes };
}

// Build AST (list-of-lists structure) from flat instructions
// Each list knows its parent list and the index of the IfNode that contains it
// This allows jumping into nested lists and continuing properly when they end
//
// Returns: { program, labelMap, mediaStore }
// - program: Nested AST structure
// - labelMap: Maps label numbers to { list, index } for direct jumps
// - mediaStore: Pass-through of mediaStore from parsed program
function buildAST(programData) {
    const instructions = programData.instructions;
    const labelMap = {};  // Maps label numbers to { list, index }

    // Build the AST - each list gets .parent and .parentIndex properties
    // parent = the containing list (null for top-level)
    // parentIndex = index of the IfNode in parent that contains this list
    function parseInstructions(startIndex, endIndex, parent = null, parentIndex = 0) {
        const result = [];
        result.parent = parent;
        result.parentIndex = parentIndex;

        let i = startIndex;

        while (i < endIndex && i < instructions.length) {
            const instr = instructions[i];
            const opcode = instr.opcode;

            // Track labels - just need list and index, parent chain is in the list itself
            if (instr.label > 0) {
                labelMap[instr.label] = { list: result, index: result.length };
            }

            // Handle if/otherwise/endif using nesting depth
            if (opcode >= 0x13 && opcode <= 0x1B || opcode === 0x4A || opcode === 0x4B || opcode === 0x4C) {
                // This is an "if" statement - find its matching otherwise/endif by counting nesting
                let otherwiseIndex = -1;
                let endifIndex = -1;
                let depth = 1;  // Start at depth 1 for this if

                for (let j = i + 1; j < instructions.length; j++) {
                    const checkInstr = instructions[j];
                    const checkOpcode = checkInstr.opcode;

                    // Another if increases depth
                    if (checkOpcode >= 0x13 && checkOpcode <= 0x1B || checkOpcode === 0x4A || checkOpcode === 0x4B || checkOpcode === 0x4C) {
                        depth++;
                    }
                    // Otherwise at our depth
                    else if (checkOpcode === 0x54 && depth === 1 && otherwiseIndex === -1) {
                        otherwiseIndex = j;
                    }
                    // Endif decreases depth
                    else if (checkOpcode === 0x55) {
                        depth--;
                        if (depth === 0) {
                            endifIndex = j;
                            break;
                        }
                    }
                }

                if (endifIndex === -1) {
                    throw new Error(`Unclosed if statement at instruction ${i}`);
                }

                // The IfNode will be placed at result.length
                const ifNodeIndex = result.length;

                // Build the IfNode - sublists know their parent and the IfNode's index
                const ifNode = {
                    type: 'if',
                    condition: instr,
                    thenList: parseInstructions(i + 1, otherwiseIndex !== -1 ? otherwiseIndex : endifIndex, result, ifNodeIndex),
                    elseList: otherwiseIndex !== -1 ? parseInstructions(otherwiseIndex + 1, endifIndex, result, ifNodeIndex) : []
                };

                // Empty elseList also needs parent info
                if (ifNode.elseList.length === 0) {
                    ifNode.elseList.parent = result;
                    ifNode.elseList.parentIndex = ifNodeIndex;
                }

                result.push(ifNode);
                i = endifIndex + 1;  // Skip past the endif
            } else if (opcode === 0x54 || opcode === 0x55) {
                // otherwise/endif - these should be handled by their matching if
                // If we encounter them here, it means they're orphaned
                // GameMaker allows extra endifs, so just skip them
                i++;
            } else {
                // Regular instruction
                result.push(instr);
                i++;
            }
        }

        return result;
    }

    const ast = parseInstructions(0, instructions.length);

    // Rebuild dataTables from the current instructions list. The cached copy
    // on programData was built at parse time from raw bytes; if the user has
    // edited any "data values" (opcode 0x1D) instructions in the editor those
    // edits would otherwise never reach the runtime. Walk the (flat) list and
    // accumulate by label, same logic as parseProgramData.
    const dataTables = {};
    let currentDataLabel = null;
    for (const instr of instructions) {
        if (instr.label > 0) currentDataLabel = instr.label;
        if (instr.opcode === 0x1D && currentDataLabel !== null) {
            if (!dataTables[currentDataLabel]) dataTables[currentDataLabel] = [];
            dataTables[currentDataLabel].push(instr.arg1 || 0, instr.arg2 || 0);
        }
    }

    return {
        program: ast,
        labelMap: labelMap,
        mediaStore: programData.mediaStore,
        dataTables: dataTables
    };
}

// =============================================================================
// PROGRAM SERIALIZATION (PRG FILE WRITING)
// =============================================================================
//
// serializeProgram() builds a PRG file from the two sources of truth:
//   1. AST (instructions) - the editable instruction list
//   2. Media Store (programData.mediaStore) - JS objects: gmSprite, gmSound, etc.
//
// 8-PHASE PROCESS (see CLAUDE.md "Serialization Architecture"):
//   Phase 1: Walk AST to collect referenced media indices
//   Phase 2: Build index remapping (old indices → fresh compact indices)
//   Phase 3: Serialize instructions with remapped arg2 values
//   Phase 4: Serialize referenced media to fresh data section
//   Phase 5: Build compact pointer table (no gaps)
//   Phase 6: Update string reference pointers
//   Phase 7: Assemble complete file
//   Phase 8: Write entry names region
//
// KEY PRINCIPLES:
//   - Binary data page is an OUTPUT, built fresh each time
//   - Only referenced media is serialized (orphaned entries ignored)
//   - Fresh compact indices assigned at serialize time
//   - Pointer table has no gaps (sequential entries only)
//
// === PRG FILE STRUCTURE ===
//
// Bytes 0-513:     Pre-header region (zeroed out - not used at runtime)
// Bytes 514-515:   Program length field (little-endian)
//                  Value = (PROGRAM_END - 514), with high byte + 6
// Bytes 516-517:   Data size field (little-endian)
//                  Value = OFFSET - DATA_END, where DATA_END = size of data section
// Bytes 518-522:   Reserved (zeros)
// Bytes 523+:      Program bytecode (4 bytes per instruction)
// After program:   Data section (sprites, sounds, songs, strings, comments)
// End of file:     Pointer table (2-byte entries, read backwards from -81)
//
// === DATA SECTION LAYOUT ===
//
// Data is packed sequentially. Each data page entry (sprite, sound, song) is
// stored WITHOUT the 5-byte magic header that standalone files have. Only the
// content starting from the name field is included.
//
// Print strings (opcode 0x3B) and comments (opcode 0x2B) are also stored in
// the data section. Print strings are 20 bytes, comments are 25 bytes.
//
// === POINTER TABLE FORMAT ===
//
// The pointer table is at the END of the file, read backwards from byte -81.
// Each entry is a 16-bit little-endian "rawAddr" value.
//
// To convert a file offset (dataStart) to a rawAddr for the pointer table:
//   dataPointer = (PROGRAM_END + DATA_END) - dataStart
//   rawAddr = OFFSET - dataPointer
//
// Special values:
//   0x0000 = End of table marker
//   0x3D90 = Sentinel (OFFSET value, used as spacer)
//
// === POINTER MATH DERIVATION ===
//
// When READING:
//   dataPointer = OFFSET - rawAddr
//   dataStart = (PROGRAM_END + DATA_END) - dataPointer
//
// Substituting:
//   dataStart = (PROGRAM_END + DATA_END) - (OFFSET - rawAddr)
//   dataStart = PROGRAM_END + DATA_END - OFFSET + rawAddr
//
// When WRITING (solving for rawAddr):
//   rawAddr = dataStart - PROGRAM_END - DATA_END + OFFSET
//   rawAddr = OFFSET - (PROGRAM_END + DATA_END - dataStart)
//   rawAddr = OFFSET - dataPointer
//
// =============================================================================

// Encode a 16-bit value as two bytes (little-endian)
function encode16bit(value) {
    return [value & 0xFF, (value >> 8) & 0xFF];
}

// Serialize program data back to PRG file format
// Returns: Uint8Array containing the complete PRG file
//
// Parameters:
//   programData: Object from parseProgramData() containing:
//     - instructions: Array of instruction objects
//     - mediaStore: JS array of media entries (sprites, sounds, songs)
//     - dataTables: Object mapping label numbers to data arrays
//
// Note: Scenes (type='scene') are NOT embedded in PRG files.
//       They are loaded from separate .PIC files on disk.
//
// IMPORTANT: C64 PRG files include a 2-byte load address header at the start.
// This is standard for all PRG files on 1541 disks. The load address tells
// BASIC where in memory to put the file data (e.g., $0400 = 0x00 0x04).
// The parser reads from fixed file positions (514, 523, etc.) that assume
// this 2-byte prefix is present. We must include it in our output.
//
// The pre-header region (bytes 2-513) contains C64 memory layout information
// that GameMaker uses for variable allocation, sprite slot pointers, etc.
// If we have the original file, we preserve this region; otherwise we zero it.
function serializeProgram(programData, originalFileData = null) {
    const LOAD_ADDRESS = 0x0400;  // C64 load address (little-endian: 0x00, 0x04)
    const PROGRAM_START = 523;    // Fixed position where program bytecode begins
    const OFFSET = 0x3D90;        // Fixed base offset used in pointer calculations

    const instructions = programData.instructions;
    const mediaStore = programData.mediaStore || [];

    // =========================================================================
    // PHASE 1: Walk AST to collect referenced media indices
    // =========================================================================
    // The AST is the source of truth. We only serialize media that's actually
    // referenced by instructions. This ensures orphaned media is not included.
    //
    // Media-referencing opcodes:
    //   0x27: sprite X is [arg2]
    //   0x28: scene X is [arg2]
    //   0x40: sound channel X = [arg2]
    //   0x60: song is [arg2]

    const referencedMediaIndices = new Set();

    for (const instr of instructions) {
        const opcode = instr.opcode;
        if (opcode === 0x27 || opcode === 0x28 || opcode === 0x40 || opcode === 0x60) {
            const mediaIdx = instr.arg2;
            if (mediaIdx > 0) {
                referencedMediaIndices.add(mediaIdx);

                // For multi-part sprites, also include the marker entries
                // which follow consecutively after the main sprite
                if (opcode === 0x27) {
                    const entry = mediaStore[mediaIdx];
                    if (entry && entry.sprite && entry.sprite.sprite) {
                        const numQuads = entry.sprite.sprite[0]?.numSprites || 1;
                        for (let q = 1; q < numQuads; q++) {
                            referencedMediaIndices.add(mediaIdx + q);
                        }
                    }
                }
            }
        }
    }


    // =========================================================================
    // PHASE 2: Build index remapping (old mediaStore indices → new compact indices)
    // =========================================================================
    // We assign fresh sequential indices starting from 1. This creates a compact
    // pointer table with no gaps.
    //
    // Example: mediaStore indices [3, 7, 8, 9] → compact indices [1, 2, 3, 4]

    const sortedOldIndices = Array.from(referencedMediaIndices).sort((a, b) => a - b);
    const indexRemap = {};  // oldIndex → newIndex
    let newIndex = 1;

    for (const oldIdx of sortedOldIndices) {
        indexRemap[oldIdx] = newIndex;
        newIndex++;
    }


    // =========================================================================
    // PHASE 3: Serialize instructions to bytecode (with remapped arg2 values)
    // =========================================================================
    // Each instruction is 4 bytes: [label, arg1, opcode, arg2]
    // For media-referencing opcodes, arg2 is remapped to the new compact index.

    const instructionBytes = [];
    const stringReferences = [];  // Track print/comment strings for later

    for (const instr of instructions) {
        // For print (0x3B) and comment (0x2B) instructions, we'll need to
        // update arg1/arg2 with the correct pointer after we know data layout.
        // For now, store placeholders and record the position.
        if (instr.opcode === 0x3B || instr.opcode === 0x2B) {
            stringReferences.push({
                byteOffset: instructionBytes.length + 1, // Position of arg1
                opcode: instr.opcode,
                // For print: use printBytes if available, else decode from instructionName
                // For comment: extract from instructionName (format: "/ comment text")
                text: instr.opcode === 0x3B ?
                    (instr.printBytes || []) :
                    instr.instructionName.slice(2) // Remove "/ " prefix
            });
        }

        // Remap arg2 for media-referencing opcodes
        let arg2 = instr.arg2 || 0;
        const opcode = instr.opcode;
        if (opcode === 0x27 || opcode === 0x28 || opcode === 0x40 || opcode === 0x60) {
            if (arg2 > 0 && indexRemap[arg2] !== undefined) {
                arg2 = indexRemap[arg2];
            }
        }

        instructionBytes.push(instr.label || 0);
        instructionBytes.push(instr.arg1 || 0);
        instructionBytes.push(instr.opcode);
        instructionBytes.push(arg2);
    }

    const PROGRAM_END = PROGRAM_START + instructionBytes.length;

    // =========================================================================
    // PHASE 4: Serialize referenced media to fresh data section
    // =========================================================================
    // Only serialize media that's actually referenced by the AST.
    // Pack tightly with no padding between entries.
    // Use NEW COMPACT INDICES for pointer table (not old mediaStore indices).
    //
    // When loading embedded sprites/sounds/songs, parseProgramData does:
    //   spriteFileData = fileData.slice(dataStart - 5)
    // This reads 5 bytes BEFORE the pointer location. In the original GM format,
    // those 5 bytes are simply whatever precedes the entry (previous data or
    // program bytecode). They serve as "fake magic" bytes but are never actually
    // used - the parsers skip them.
    //
    // NOTE: Scenes are NOT fully embedded (they load from .PIC files on disk),
    // but their NAME still needs to be stored so parseProgramData can look them up.

    const dataSection = [];
    const compactPointers = {};  // Maps NEW compact index -> offset in data section

    // Process referenced indices in sorted order (same order as indexRemap assignment)
    for (const oldIdx of sortedOldIndices) {
        const entry = mediaStore[oldIdx];
        if (!entry) {
            // A referenced media index has no entry — this would corrupt the
            // pointer table. Surface immediately rather than write garbage that
            // fails cryptically on reload (e.g. a missing field on the header).
            throw new Error(
                `serializeProgram: instruction references mediaStore[${oldIdx}] ` +
                `but no entry exists there. State is inconsistent.`
            );
        }

        const newIdx = indexRemap[oldIdx];

        // Skip subsprite marker entries - their data is written when processing
        // the main sprite entry. Multi-part sprites always have ONE gmSprite
        // object in the main entry, with marker entries for subsprites.
        if (entry.type === 'sprite' && isMarkerEntry(entry)) {
            continue;
        }

        // Validate sprite entries have both spriteFileData (raw bytes) and the
        // parsed sprite object before we record the pointer. If either is
        // missing, the data write below silently no-ops while the pointer is
        // already set — producing a file whose pointer table points to the
        // next entry's data, which fails to parse as a sprite header.
        if (entry.type === 'sprite' && (!entry.spriteFileData || !entry.sprite)) {
            throw new Error(
                `serializeProgram: sprite mediaStore[${oldIdx}] "${entry.name}" ` +
                `is missing ${!entry.spriteFileData ? 'spriteFileData' : 'sprite (parsed instance)'}. ` +
                `Save aborted — please report this case.`
            );
        }
        if (entry.type === 'sound' && !entry.soundFileData) {
            throw new Error(
                `serializeProgram: sound mediaStore[${oldIdx}] "${entry.name}" is missing soundFileData.`
            );
        }
        if (entry.type === 'song' && !entry.songFileData) {
            throw new Error(
                `serializeProgram: song mediaStore[${oldIdx}] "${entry.name}" is missing songFileData.`
            );
        }

        // Record where this entry's data starts using NEW compact index
        compactPointers[newIdx] = dataSection.length;

        // Get the raw file data and calculate the correct size to write.
        // The xxxFileData arrays include 5 "fake" magic bytes at the start (read from
        // before the actual data in the PRG). We skip those and write only the actual
        // data. Size calculation varies by type:
        //
        // - Sprites: For multi-quad sprites, we write all quads and set up pointers
        //            for the marker entries. Single-quad uses quadSizeInBytes(0).
        // - Sounds: HEADER_SIZE + frameCount * FRAME_SIZE - 5 (13 + 16*frames)
        // - Songs: Must parse to find end (FF marker) - variable length
        let rawData = null;
        let dataSize = 0;  // Size of data to write (excluding the 5 fake magic bytes)

        if (entry.type === 'sprite' && entry.spriteFileData && entry.sprite) {
            rawData = entry.spriteFileData;

            // Main sprite: write main header + quad 0 frames
            dataSize = entry.sprite.quadSizeInBytes(0);

            // Check if this is a multi-part sprite
            const numQuads = entry.sprite.sprite[0]?.numSprites || 1;

            if (numQuads > 1) {
                // Multi-part sprite: write main sprite data first (quad 0)
                // Note: quadSizeInBytes uses HEADER_DATA_SIZE=37 (.SPR format), but
                // PRG-loaded data uses data page format with 32-byte header.
                // Correct size: 32 + frames*64 (not 37 + frames*64)
                const DATA_PAGE_HEADER_SIZE = 32;  // 6-byte name + 26-byte header
                const quad0Frames = entry.sprite.sprite[0]?.totalFrames || 1;
                const mainDataSize = DATA_PAGE_HEADER_SIZE + (quad0Frames * gmSprite.SPRITE_DATA_SIZE);
                const mainStart = dataSection.length;
                const mainEndOffset = 5 + mainDataSize;
                for (let i = 5; i < mainEndOffset && i < rawData.length; i++) {
                    dataSection.push(rawData[i]);
                }

                // Re-encode the name in GM screen codes — defensive against
                // .SPR files that stored the name as raw ASCII (older sprite-maker
                // output). The PRG parser decodes with decodeString which only
                // recognises a-z as 0x01..0x1A, so ASCII letters round-tripped
                // through as '�'. Mirrors what we do for marker entries below.
                const mainNameBytes = encodeString(entry.name, 6);
                for (let i = 0; i < 6; i++) {
                    dataSection[mainStart + i] = mainNameBytes[i];
                }

                // Now decompose the gmSprite and write each additional quad as a
                // separate data page entry. Markers are at consecutive indices after
                // the main entry (both disk-loaded and PRG-loaded guarantee this).
                const mainSprite = entry.sprite;

                // Calculate offsets within spriteFileData for each quad
                // When parsed from PRG, spriteFileData contains data page format:
                // [5 fake bytes][32-byte data page entry][quad0 frames][32-byte subsprite entry][quad1 frames]...
                // We already wrote the main sprite, so start after it
                let fileOffset = 5 + mainDataSize;  // After fake magic + main data page entry

                for (let q = 1; q < numQuads; q++) {
                    // Marker should be at the next consecutive media store index
                    const oldMarkerIdx = oldIdx + q;
                    const marker = mediaStore[oldMarkerIdx];

                    // Verify this is the expected marker entry. Markers have
                    // quadIndex > 0 and no spriteFileData of their own.
                    if (!marker || marker.quadIndex !== q) {
                        console.warn(`Expected marker at mediaStore[${oldMarkerIdx}] with quadIndex=${q}, got:`, marker);
                        continue;
                    }

                    // Record pointer using NEW compact index
                    const newMarkerIdx = indexRemap[oldMarkerIdx];
                    const subheaderStart = dataSection.length;
                    compactPointers[newMarkerIdx] = subheaderStart;

                    // Write subheader + frames for this quad
                    const qFrames = mainSprite.sprite[q]?.totalFrames || quad0Frames;
                    const subDataSize = gmSprite.SUBHEADER_DATA_SIZE + (qFrames * gmSprite.SPRITE_DATA_SIZE);

                    for (let i = 0; i < subDataSize && (fileOffset + i) < rawData.length; i++) {
                        dataSection.push(rawData[fileOffset + i]);
                    }

                    // Overwrite bytes 0-5 with marker's name (6 chars for data page entry)
                    // Parser reads 6-byte name at offset 0 for all entries
                    const markerName = marker.name || ('-' + entry.name.substring(0, 5));
                    const nameBytes = encodeString(markerName, 6);
                    for (let i = 0; i < 6; i++) {
                        dataSection[subheaderStart + i] = nameBytes[i];
                    }

                    // Move to next quad in file
                    fileOffset += subDataSize;
                }

                continue;  // Skip normal rawData writing - we handled everything
            }
            // Single-quad sprite falls through to normal rawData writing below
        } else if (entry.type === 'sound' && entry.soundFileData) {
            rawData = entry.soundFileData;
            // Sound size: header (18) + frames (16 each) - magic (5) = 13 + 16*frames
            // frameCount is at byte 17 in the file (with magic), or byte 12 without
            const frameCount = rawData[17];  // Byte 17 has frame count (with magic prefix)
            dataSize = (gmSound.HEADER_SIZE - 5) + (frameCount * gmSound.FRAME_SIZE);
        } else if (entry.type === 'song' && entry.songFileData) {
            rawData = entry.songFileData;
            // Songs are variable length. Format:
            //   [0-1]:   Load address
            //   [2-4]:   Magic "GEK"
            //   [5-10]:  Name (6 bytes)
            //   [11-19]: Unknown
            //   [20]:    Tempo
            //   [21-23]: Instruments
            //   [24-26]: FF FF FF delimiter
            //   [27-33]: Preamble
            //   [34+]:   Note data (<duration> <pitch> pairs)
            //   Each channel ends with FF FF, file ends with single FF
            // Parse through to find actual end.
            const maxSearch = Math.min(rawData.length, 5000);
            let pos = 34;  // Note data starts at byte 34
            let channelsEnded = 0;

            while (pos < maxSearch && channelsEnded < 3) {
                const byte = rawData[pos];
                if (byte === 0xFF) {
                    if (pos + 1 < maxSearch && rawData[pos + 1] === 0xFF) {
                        // FF FF = end of channel
                        channelsEnded++;
                        pos += 2;
                    } else {
                        // Single FF = end of file
                        pos++;
                        break;
                    }
                } else {
                    // Skip duration/pitch pair
                    pos += 2;
                }
            }
            // dataSize = bytes from rawData[5] to rawData[pos-1] inclusive
            dataSize = pos - 5;
            // Ensure we include at least the header (29 bytes without magic)
            dataSize = Math.max(dataSize, 29);
        } else if (entry.type === 'scene') {
            // Scenes: only store the 6-byte name (PETSCII encoded)
            // The actual scene data is loaded from .PIC files on disk
            // We need to encode the name from ASCII back to PETSCII
            const nameBytes = encodeString(entry.name, 6);
            for (const byte of nameBytes) {
                dataSection.push(byte);
            }
            continue;  // Skip the rawData writing below
        }

        if (rawData && dataSize > 0) {
            // Write data starting from byte 5 (skipping fake magic), for dataSize bytes
            const entryStart = dataSection.length;
            const endOffset = 5 + dataSize;
            for (let i = 5; i < endOffset && i < rawData.length; i++) {
                dataSection.push(rawData[i]);
            }

            // Sprite/sound/song names live at bytes 0-5 of the data page entry
            // and must be in GM screen-code charset for the parser's decodeString
            // to round-trip. Re-encode from entry.name defensively — see the
            // multi-quad branch above for the full story.
            if (entry.type === 'sprite') {
                const nameBytes = encodeString(entry.name, 6);
                for (let i = 0; i < 6; i++) dataSection[entryStart + i] = nameBytes[i];
            }
        }
    }

    // Pack string references (print strings and comments)
    const stringPointers = [];  // Track offsets for updating instruction args

    for (const ref of stringReferences) {
        stringPointers.push({
            byteOffset: ref.byteOffset,
            dataOffset: dataSection.length
        });

        if (ref.opcode === 0x3B) {
            // Print string: 20 bytes
            const bytes = ref.text;
            for (let i = 0; i < 20; i++) {
                dataSection.push(bytes[i] || 0x20);  // Pad with spaces
            }
        } else {
            // Comment: 25 bytes
            // Must convert ASCII text back to PETSCII/GameMaker encoding
            // using encodeChar from c64lib.js
            const text = ref.text;
            for (let i = 0; i < 25; i++) {
                if (i < text.length) {
                    dataSection.push(encodeChar(text[i]));
                } else {
                    dataSection.push(0x20);  // Pad with spaces
                }
            }
        }
    }

    const DATA_END = dataSection.length;

    // =========================================================================
    // PHASE 5: Build compact pointer table
    // =========================================================================
    // Since we remapped indices, we build a COMPACT pointer table with no gaps.
    // Entries are sequential: [sentinel, entry1, entry2, entry3, ...]
    // No placeholders needed - instructions were remapped to use compact indices.

    const pointerTable = [];

    // Add leading OFFSET sentinel at position -81
    // The original GameMaker format always starts with an OFFSET sentinel before
    // the actual data page entries. The parser skips this when indexing.
    pointerTable.push(...encode16bit(OFFSET));

    // Add entries for compact indices (1, 2, 3, ... up to number of referenced entries)
    const maxCompactIndex = sortedOldIndices.length;

    for (let compactIdx = 1; compactIdx <= maxCompactIndex; compactIdx++) {
        const dataOffset = compactPointers[compactIdx];

        if (dataOffset === undefined) {
            // This shouldn't happen with compact indices, but handle gracefully
            console.warn(`Missing data offset for compact index ${compactIdx}`);
            pointerTable.push(...encode16bit(0x00be));
            continue;
        }

        // Calculate rawAddr from data offset
        // dataStart (absolute file position) = PROGRAM_END + dataOffset
        // dataPointer = (PROGRAM_END + DATA_END) - dataStart
        //             = (PROGRAM_END + DATA_END) - (PROGRAM_END + dataOffset)
        //             = DATA_END - dataOffset
        // rawAddr = OFFSET - dataPointer = OFFSET - DATA_END + dataOffset
        const rawAddr = OFFSET - DATA_END + dataOffset;
        pointerTable.push(...encode16bit(rawAddr));

        // Find the original entry for logging
        const oldIdx = sortedOldIndices[compactIdx - 1];
        const entry = mediaStore[oldIdx];
    }

    // Add end-of-table marker
    pointerTable.push(0x00, 0x00);

    // =========================================================================
    // PHASE 6: Update string reference pointers in instructions
    // =========================================================================

    for (const ptr of stringPointers) {
        // Calculate rawAddr for this string
        // Same formula as data page entries
        const rawAddr = OFFSET - DATA_END + ptr.dataOffset;
        const [lowByte, highByte] = encode16bit(rawAddr);

        // Update arg1 and arg2 in instruction bytes
        instructionBytes[ptr.byteOffset] = lowByte;      // arg1
        instructionBytes[ptr.byteOffset + 2] = highByte; // arg2
    }

    // =========================================================================
    // PHASE 7: Assemble complete file
    // =========================================================================

    // Calculate total size using the formula derived from analyzing original GM files:
    //   fileSize = PROGRAM_END + DATA_END + 623
    //
    // The 623 bytes after DATA_END consist of:
    //   - 542 bytes: "gap" region (mostly zeros, pointer table entries stored here)
    //   - 81 bytes: reserved region containing:
    //     - 2 bytes: sentinel $3D90 at position -81
    //     - 79 bytes: data page entry names (8 bytes each: 6-char name + 2-char slot)
    //
    // This formula was verified against 7 of 8 original GM PRG files (all except 2SCENE).
    // The pointer table entries are written backwards starting from position -81,
    // growing into the 542-byte gap region.
    const RESERVED_AFTER_DATA = 623;
    const fileSize = PROGRAM_END + DATA_END + RESERVED_AFTER_DATA;

    const result = new Uint8Array(fileSize);

    // Load address: bytes 0-1 (little-endian $0400)
    // This is the standard C64 PRG file format - every PRG on disk starts with this.
    result[0] = LOAD_ADDRESS & 0xFF;          // 0x00
    result[1] = (LOAD_ADDRESS >> 8) & 0xFF;   // 0x04

    // Pre-header: bytes 2-513
    // This region contains C64 memory layout information (variable allocation,
    // sprite slot pointers, etc.). Preserve from original file if available.
    if (originalFileData && originalFileData.length >= 514) {
        for (let i = 2; i < 514; i++) {
            result[i] = originalFileData[i];
        }
    }
    // Otherwise leave as zeros (Uint8Array initialization)

    // =========================================================================
    // LABEL TABLE: bytes 3-257 (low) and 259-513 (high)
    // =========================================================================
    //
    // The label table maps label numbers (1-255) to memory addresses.
    // For label N:
    //   - Low byte stored at result[N + 2]  (file position N in data array)
    //   - High byte stored at result[N + 258]  (file position 256+N in data array)
    //
    // The value is the MEMORY ADDRESS of the instruction with that label:
    //   memoryAddr = LOAD_ADDRESS + (filePosition - 2)
    //   where filePosition = PROGRAM_START + (instructionIndex * 4)
    //
    // This table is used by the C64 GameMaker runtime for:
    //   - GOTO/GOSUB: Jump directly to label address
    //   - INSERT/DELETE: Adjust addresses when program is modified
    //
    // IMPORTANT: We always rebuild from scratch rather than preserving original data.
    // The original C64 editor leaves "deleted label remnants" (high byte zeroed,
    // low byte contains partial address) but we write clean $0000 for unused slots.
    //
    // First, zero out the entire label table to remove any deleted label remnants
    // that may have been copied from originalFileData.
    for (let labelNum = 1; labelNum < 256; labelNum++) {
        result[labelNum + 2] = 0;    // Low byte
        result[labelNum + 258] = 0;  // High byte
    }

    // Now write entries for labels that are actually used
    for (let i = 0; i < instructions.length; i++) {
        const instr = instructions[i];
        if (instr.label && instr.label > 0) {
            // Calculate the memory address of this instruction.
            //
            // filePosition = PROGRAM_START + (i * 4)   <- position in the PRG file
            // The PRG file has a 2-byte load address prefix (bytes 0-1).
            // When loaded into C64 memory, bytes 2+ go to LOAD_ADDRESS.
            // So the memory address = LOAD_ADDRESS + (filePosition - 2)
            //
            const filePosition = PROGRAM_START + (i * 4);
            const memoryAddr = LOAD_ADDRESS + (filePosition - 2);

            // Store in label table
            result[instr.label + 2] = memoryAddr & 0xFF;           // Low byte
            result[instr.label + 258] = (memoryAddr >> 8) & 0xFF;  // High byte
        }
    }

    // Header: bytes 514-517
    // Byte 514-515: Program length encoding
    // Parser reads: PROGRAM_END = 514 + decode16bit(fileData[514], fileData[515] - 6)
    // So we encode: (PROGRAM_END - 514) with high byte + 6
    const progLength = PROGRAM_END - 514;
    result[514] = progLength & 0xFF;
    result[515] = ((progLength >> 8) & 0xFF) + 6;

    // Byte 516-517: Data size encoding
    // Parser reads: DATA_END = OFFSET - decode16bit(fileData[516], fileData[517])
    // So we encode: OFFSET - DATA_END
    const dataSize = OFFSET - DATA_END;
    result[516] = dataSize & 0xFF;
    result[517] = (dataSize >> 8) & 0xFF;

    // Bytes 518-522: reserved (zeros, already done)

    // Instructions: bytes 523 to PROGRAM_END
    for (let i = 0; i < instructionBytes.length; i++) {
        result[PROGRAM_START + i] = instructionBytes[i];
    }

    // Data section: bytes PROGRAM_END to PROGRAM_END + DATA_END
    for (let i = 0; i < dataSection.length; i++) {
        result[PROGRAM_END + i] = dataSection[i];
    }

    // Pointer table: at end of file, readable from byte -81 backwards
    // Parser reads: fileData.at(-81), at(-83), at(-85), ... (pairs going backwards)
    // So we write each 2-byte entry at decreasing positions from -81
    // Entry 1 at -81/-80, Entry 2 at -83/-82, Entry 3 at -85/-84, etc.
    for (let i = 0; i < pointerTable.length; i += 2) {
        const writePos = fileSize - 81 - i;  // -81, -83, -85, ... relative to end
        result[writePos] = pointerTable[i];      // low byte
        result[writePos + 1] = pointerTable[i + 1];  // high byte
    }

    // =========================================================================
    // PHASE 8: Write last 79 bytes (entry names region)
    // =========================================================================
    //
    // The last 81 bytes of the file contain:
    //   - Bytes -81/-80: Sentinel $3D90 (already written as first pointer entry)
    //   - Bytes -79 to -1: Entry names/editor state (79 bytes)
    //   - Last byte (-1): Terminator 0x80
    //
    // Analysis of original GM files shows this region contains sprite/entry names
    // that don't directly correspond to mediaStore order. This appears to be
    // editor-specific state. For maximum compatibility, we preserve the original
    // data when available. Otherwise, we write mediaStore entry names.

    // The last 79 bytes appear to track sprite SLOT assignments (sprite1-sprite8).
    // Format: 8 bytes per slot (6-char name + 2-char slot marker like "1-")
    // When only one sprite is ever assigned to a slot, GM shows that sprite's name
    // in instructions. Otherwise it shows "SPRITE1" etc.
    //
    // For now, blank these bytes to test what breaks. We'll need to scan
    // instructions to properly reconstruct slot assignments later.
    //
    // TODO: Implement proper slot assignment tracking by scanning "sprite N is X"
    // instructions to determine which sprites are assigned to which slots.

    const ENTRY_NAME_START = fileSize - 79;

    // Blank the entry region with spaces
    for (let i = 0; i < 79; i++) {
        result[ENTRY_NAME_START + i] = 0x20;  // Space
    }

    // Write terminator at last byte
    result[fileSize - 1] = 0x80;

    return result;
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.parseProgramData = parseProgramData;
    globalThis.serializeProgram = serializeProgram;
    globalThis.buildAST = buildAST;
    globalThis.isMarkerEntry = isMarkerEntry;
}

