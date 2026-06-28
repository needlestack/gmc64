/**
 * d64lib.js - Pure C64/1541 D64 Disk Image Library
 *
 * A stateless library for reading and writing D64 disk images.
 * No DOM dependencies, no callbacks, no localStorage - just pure disk operations.
 *
 * Usage:
 *   const disk = new D64(arrayBuffer);  // Load from file
 *   const disk = D64.createEmpty();      // Create blank disk
 *
 *   const dir = disk.getDirectory();
 *   const fileData = disk.readFile('MYGAME/PRG');
 *   disk.writeFile('NEWFILE/PRG', data, D64.FILE_TYPE_PRG);
 *   disk.deleteFile('OLDFILE/PRG');
 *
 *   const blob = disk.toBlob();  // For download
 */

class D64 {
    // Disk geometry constants
    static DIR_TRACK = 18;
    static SECTOR_SIZE = 256;
    static MAX_TRACKS = 35;

    // Sectors per track - 1541 disk layout
    static SECTORS_PER_TRACK = [
        0,  // placeholder for index 0 (tracks are 1-indexed)
        21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,  // tracks 1-17
        19, 19, 19, 19, 19, 19, 19,                                          // tracks 18-24
        18, 18, 18, 18, 18, 18,                                              // tracks 25-30
        17, 17, 17, 17, 17                                                   // tracks 31-35
    ];

    // File type constants (matching 1541 DOS)
    static FILE_TYPE_DEL = 0x00;
    static FILE_TYPE_SEQ = 0x81;
    static FILE_TYPE_PRG = 0x82;
    static FILE_TYPE_USR = 0x83;
    static FILE_TYPE_REL = 0x84;

    // Interleave for file data sectors (1541 uses 10)
    static FILE_INTERLEAVE = 10;

    // Standard D64 size (35 tracks)
    static DISK_SIZE = 174848;

    /**
     * Create a D64 instance from disk data
     * @param {Uint8Array|ArrayBuffer} data - Raw D64 disk image data
     */
    constructor(data) {
        if (data instanceof ArrayBuffer) {
            this.data = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
            this.data = data;
        } else {
            throw new Error('D64 constructor requires Uint8Array or ArrayBuffer');
        }
    }

    /**
     * Create an empty formatted D64 disk
     * @param {string} diskName - Name for the disk (max 16 chars)
     * @param {string} diskId - 2-character disk ID
     * @returns {D64} New D64 instance
     */
    static createEmpty(diskName = 'EMPTY DISK', diskId = '00') {
        const data = new Uint8Array(D64.DISK_SIZE);

        // Initialize BAM (track 18, sector 0)
        const bamOffset = D64._getTrackSectorOffset(D64.DIR_TRACK, 0);

        // First directory track/sector pointer
        data[bamOffset + 0] = D64.DIR_TRACK;
        data[bamOffset + 1] = 1;

        // DOS type
        data[bamOffset + 2] = 0x41;  // 'A' for 1541
        data[bamOffset + 3] = 0x00;

        // Initialize BAM entries for all tracks
        for (let track = 1; track <= D64.MAX_TRACKS; track++) {
            const sectors = D64.SECTORS_PER_TRACK[track];
            const offset = bamOffset + 4 + (track - 1) * 4;

            if (track === D64.DIR_TRACK) {
                // Directory track - mark sectors 0-1 as used, rest as free
                data[offset] = sectors - 2;  // free count
                data[offset + 1] = 0xFC;     // sectors 2-7 free
                data[offset + 2] = 0xFF;     // sectors 8-15 free
                data[offset + 3] = 0x07;     // sectors 16-18 free
            } else {
                // Data track - all sectors free
                data[offset] = sectors;
                // Set bitmap bits for available sectors
                const fullBytes = Math.floor(sectors / 8);
                const remainingBits = sectors % 8;
                for (let i = 0; i < fullBytes; i++) {
                    data[offset + 1 + i] = 0xFF;
                }
                if (remainingBits > 0) {
                    data[offset + 1 + fullBytes] = (1 << remainingBits) - 1;
                }
            }
        }

        // Disk name at BAM + 144
        const nameOffset = bamOffset + 144;
        const paddedName = diskName.substring(0, 16).toUpperCase().padEnd(16, '\xA0');
        for (let i = 0; i < 16; i++) {
            data[nameOffset + i] = paddedName.charCodeAt(i);
        }

        // Disk ID at BAM + 162
        data[bamOffset + 162] = diskId.charCodeAt(0) || 0x30;
        data[bamOffset + 163] = diskId.charCodeAt(1) || 0x30;

        // DOS type indicator
        data[bamOffset + 165] = 0x32;  // '2'
        data[bamOffset + 166] = 0x41;  // 'A'

        // Initialize first directory sector (track 18, sector 1)
        const dirOffset = D64._getTrackSectorOffset(D64.DIR_TRACK, 1);
        data[dirOffset + 0] = 0x00;   // End of chain
        data[dirOffset + 1] = 0xFF;   // Unused bytes marker

        return new D64(data);
    }

    // =========================================================================
    // DISK GEOMETRY
    // =========================================================================

    /**
     * Calculate byte offset for a track/sector
     * @param {number} track - Track number (1-35)
     * @param {number} sector - Sector number (0-20)
     * @returns {number} Byte offset in disk image
     */
    static _getTrackSectorOffset(track, sector) {
        if (track < 1 || track > D64.MAX_TRACKS) {
            throw new Error(`Invalid track: ${track}`);
        }
        if (sector < 0 || sector >= D64.SECTORS_PER_TRACK[track]) {
            throw new Error(`Invalid sector ${sector} for track ${track}`);
        }

        let offset = 0;
        for (let t = 1; t < track; t++) {
            offset += D64.SECTORS_PER_TRACK[t] * D64.SECTOR_SIZE;
        }
        offset += sector * D64.SECTOR_SIZE;
        return offset;
    }

    /**
     * Get byte offset for a track/sector (instance method)
     */
    getTrackSectorOffset(track, sector) {
        return D64._getTrackSectorOffset(track, sector);
    }

    // =========================================================================
    // READING
    // =========================================================================

    /**
     * Follow a sector chain and return all data
     * @param {number} track - Starting track
     * @param {number} sector - Starting sector
     * @param {boolean} includeLinks - Include T/S link bytes (for directory)
     * @returns {Uint8Array} Chained data
     */
    getChainedData(track, sector, includeLinks = false) {
        const chainData = [];
        const MAX_SECTORS = 768;  // Safety limit
        let sectorCount = 0;

        const dataStart = includeLinks ? 0 : 2;

        while (track !== 0) {
            const sectorOffset = D64._getTrackSectorOffset(track, sector);
            const sectorData = this.data.slice(sectorOffset, sectorOffset + D64.SECTOR_SIZE);

            const nextTrack = sectorData[0];
            const nextSector = sectorData[1];

            if (nextTrack === 0) {
                // Last sector - nextSector indicates bytes used
                // Per 1541 convention: 0 means full sector (254 bytes)
                const endOffset = nextSector === 0 ? 256 : nextSector;
                chainData.push(...sectorData.slice(dataStart, endOffset));
                break;
            }

            chainData.push(...sectorData.slice(dataStart));

            track = nextTrack;
            sector = nextSector;

            if (++sectorCount > MAX_SECTORS) {
                throw new Error('Sector chain too long (possible corruption)');
            }
        }

        return new Uint8Array(chainData);
    }

    /**
     * Get disk name from BAM
     * @returns {string} Disk name
     */
    getDiskName() {
        const bamOffset = D64._getTrackSectorOffset(D64.DIR_TRACK, 0);
        const nameOffset = bamOffset + 144;
        const rawName = this.data.slice(nameOffset, nameOffset + 16);
        return D64._parseFileName(rawName);
    }

    /**
     * Parse directory and return file entries
     * @returns {Array} Array of {fileName, fileType, fileSize, startTrack, startSector}
     */
    getDirectory() {
        const directoryData = this.getChainedData(D64.DIR_TRACK, 1, true);
        const entries = [];
        const DIR_ENTRY_SIZE = 32;

        for (let offset = 0; offset < directoryData.length; offset += DIR_ENTRY_SIZE) {
            const entry = directoryData.slice(offset, offset + DIR_ENTRY_SIZE);

            // File type 0x00 = scratched/empty
            if (entry[2] === 0x00) continue;

            const fileName = D64._parseFileName(entry.slice(5, 21));
            const fileType = D64._parseFileType(entry[2]);

            if (fileType === 'DEL') continue;

            entries.push({
                fileName,
                fileType,
                fileSize: entry[30] | (entry[31] << 8),
                startTrack: entry[3],
                startSector: entry[4]
            });
        }

        return entries;
    }

    /**
     * Read a file by name
     * @param {string} fileName - File name to find
     * @returns {Uint8Array|null} File data or null if not found
     */
    readFile(fileName) {
        const normalizedName = fileName.trim().toUpperCase();
        const entry = this.getDirectory().find(
            e => e.fileName.trim().toUpperCase() === normalizedName
        );

        if (!entry) return null;

        return this.getChainedData(entry.startTrack, entry.startSector);
    }

    // =========================================================================
    // BAM (BLOCK AVAILABILITY MAP)
    // =========================================================================

    /**
     * Get BAM offset for a track
     */
    _getBAMOffset(track) {
        return D64._getTrackSectorOffset(D64.DIR_TRACK, 0) + 4 + (track - 1) * 4;
    }

    /**
     * Check if a sector is free
     */
    isSectorFree(track, sector) {
        const bamOffset = this._getBAMOffset(track);
        const byteIndex = Math.floor(sector / 8);
        const bitIndex = sector % 8;
        return (this.data[bamOffset + 1 + byteIndex] & (1 << bitIndex)) !== 0;
    }

    /**
     * Allocate a sector (mark as used)
     */
    _allocateSector(track, sector) {
        if (!this.isSectorFree(track, sector)) {
            throw new Error(`Sector ${track}/${sector} already allocated`);
        }

        const bamOffset = this._getBAMOffset(track);
        this.data[bamOffset]--;  // Decrement free count

        const byteIndex = Math.floor(sector / 8);
        const bitIndex = sector % 8;
        this.data[bamOffset + 1 + byteIndex] &= ~(1 << bitIndex);
    }

    /**
     * Free a sector (mark as available)
     */
    _freeSector(track, sector) {
        if (this.isSectorFree(track, sector)) return;

        const bamOffset = this._getBAMOffset(track);
        this.data[bamOffset]++;  // Increment free count

        const byteIndex = Math.floor(sector / 8);
        const bitIndex = sector % 8;
        this.data[bamOffset + 1 + byteIndex] |= (1 << bitIndex);
    }

    /**
     * Count total free blocks on disk
     */
    getFreeBlocks() {
        let total = 0;
        for (let track = 1; track <= D64.MAX_TRACKS; track++) {
            if (track === D64.DIR_TRACK) continue;
            total += this.data[this._getBAMOffset(track)];
        }
        return total;
    }

    // =========================================================================
    // SECTOR ALLOCATION
    // =========================================================================

    /**
     * Find a free sector on a specific track
     */
    _findFreeSectorOnTrack(track, startSector = 0) {
        const numSectors = D64.SECTORS_PER_TRACK[track];
        let sector = startSector;

        for (let i = 0; i < numSectors; i++) {
            if (this.isSectorFree(track, sector)) {
                return sector;
            }
            sector = (sector + 1) % numSectors;
        }
        return -1;
    }

    /**
     * Find any free sector on disk
     */
    _findFreeSector(preferTrack = 1, preferSector = 0) {
        // Try preferred track first
        if (preferTrack !== D64.DIR_TRACK) {
            const sector = this._findFreeSectorOnTrack(preferTrack, preferSector);
            if (sector !== -1) {
                return { track: preferTrack, sector };
            }
        }

        // Search all tracks
        for (let track = 1; track <= D64.MAX_TRACKS; track++) {
            if (track === D64.DIR_TRACK) continue;
            const sector = this._findFreeSectorOnTrack(track, 0);
            if (sector !== -1) {
                return { track, sector };
            }
        }
        return null;
    }

    /**
     * Allocate a chain of sectors
     */
    _allocateSectorChain(numSectors) {
        const chain = [];
        let currentTrack = 1;
        let currentSector = 0;

        for (let i = 0; i < numSectors; i++) {
            const nextSector = (currentSector + D64.FILE_INTERLEAVE) %
                               D64.SECTORS_PER_TRACK[currentTrack];
            const location = this._findFreeSector(currentTrack, nextSector);

            if (!location) {
                // Rollback
                for (const loc of chain) {
                    this._freeSector(loc.track, loc.sector);
                }
                return null;
            }

            this._allocateSector(location.track, location.sector);
            chain.push(location);

            currentTrack = location.track;
            currentSector = location.sector;
        }

        return chain;
    }

    // =========================================================================
    // WRITING
    // =========================================================================

    /**
     * Find an empty directory entry slot
     */
    _findEmptyDirectoryEntry() {
        let track = D64.DIR_TRACK;
        let sector = 1;

        while (track !== 0) {
            const sectorOffset = D64._getTrackSectorOffset(track, sector);

            for (let entry = 0; entry < 8; entry++) {
                const entryOffset = sectorOffset + entry * 32;
                if (this.data[entryOffset + 2] === 0x00) {
                    return { track, sector, offset: entry * 32 };
                }
            }

            const nextTrack = this.data[sectorOffset];
            const nextSector = this.data[sectorOffset + 1];

            if (nextTrack === 0) {
                // Try to extend directory
                const newDirSector = this._findFreeSectorOnTrack(D64.DIR_TRACK, sector);
                if (newDirSector !== -1 && newDirSector !== 0) {
                    this._allocateSector(D64.DIR_TRACK, newDirSector);
                    this.data[sectorOffset] = D64.DIR_TRACK;
                    this.data[sectorOffset + 1] = newDirSector;

                    const newOffset = D64._getTrackSectorOffset(D64.DIR_TRACK, newDirSector);
                    this.data.fill(0, newOffset, newOffset + 256);
                    this.data[newOffset + 1] = 0xFF;

                    return { track: D64.DIR_TRACK, sector: newDirSector, offset: 0 };
                }
                break;
            }

            track = nextTrack;
            sector = nextSector;
        }

        return null;
    }

    /**
     * Write file data to a sector chain
     */
    _writeFileData(fileData, sectorChain) {
        let dataOffset = 0;

        for (let i = 0; i < sectorChain.length; i++) {
            const { track, sector } = sectorChain[i];
            const sectorOffset = D64._getTrackSectorOffset(track, sector);

            const remainingData = fileData.length - dataOffset;
            const bytesThisSector = Math.min(254, remainingData);

            if (i < sectorChain.length - 1) {
                this.data[sectorOffset] = sectorChain[i + 1].track;
                this.data[sectorOffset + 1] = sectorChain[i + 1].sector;
            } else {
                // Last sector: byte 0 = $00, byte 1 = bytes used indicator
                // Per 1541 convention: 0 means full sector (254 bytes),
                // otherwise it's the offset past the last data byte
                this.data[sectorOffset] = 0x00;
                this.data[sectorOffset + 1] = bytesThisSector === 254 ? 0 : bytesThisSector + 2;
            }

            for (let j = 0; j < bytesThisSector; j++) {
                this.data[sectorOffset + 2 + j] = fileData[dataOffset + j];
            }
            for (let j = bytesThisSector; j < 254; j++) {
                this.data[sectorOffset + 2 + j] = 0x00;
            }

            dataOffset += bytesThisSector;
        }
    }

    /**
     * Write a file to disk
     * @param {string} fileName - File name (max 16 chars)
     * @param {Uint8Array} fileData - File contents
     * @param {number} fileType - File type constant (default: PRG)
     * @returns {boolean} Success
     */
    writeFile(fileName, fileData, fileType = D64.FILE_TYPE_PRG) {
        if (!fileName || fileName.length === 0) {
            throw new Error('Invalid filename');
        }
        if (!fileData || fileData.length === 0) {
            throw new Error('No file data');
        }

        const numSectors = Math.ceil(fileData.length / 254);

        if (this.getFreeBlocks() < numSectors) {
            throw new Error(`Not enough space. Need ${numSectors}, have ${this.getFreeBlocks()}`);
        }

        const dirEntry = this._findEmptyDirectoryEntry();
        if (!dirEntry) {
            throw new Error('Directory is full');
        }

        const sectorChain = this._allocateSectorChain(numSectors);
        if (!sectorChain) {
            throw new Error('Failed to allocate sectors');
        }

        this._writeFileData(fileData, sectorChain);
        this._writeDirectoryEntry(dirEntry, fileName, fileType,
                                  sectorChain[0].track, sectorChain[0].sector, numSectors);

        return true;
    }

    /**
     * Write a directory entry
     */
    _writeDirectoryEntry(dirLocation, fileName, fileType, startTrack, startSector, blocks) {
        const sectorOffset = D64._getTrackSectorOffset(dirLocation.track, dirLocation.sector);
        const entryOffset = sectorOffset + dirLocation.offset;

        this.data[entryOffset + 2] = fileType;
        this.data[entryOffset + 3] = startTrack;
        this.data[entryOffset + 4] = startSector;

        // Filename in PETSCII (padded with $A0)
        const petsciiName = D64.stringToPetscii(fileName.substring(0, 16), 16);
        for (let i = 0; i < 16; i++) {
            this.data[entryOffset + 5 + i] = petsciiName[i];
        }

        // Clear unused fields
        for (let i = 21; i < 30; i++) {
            this.data[entryOffset + i] = 0x00;
        }

        // File size in blocks
        this.data[entryOffset + 30] = blocks & 0xFF;
        this.data[entryOffset + 31] = (blocks >> 8) & 0xFF;
    }

    /**
     * Delete a file from disk
     * @param {string} fileName - File to delete
     * @returns {boolean} Success
     */
    deleteFile(fileName) {
        const normalizedName = fileName.trim().toUpperCase();
        const entry = this.getDirectory().find(
            e => e.fileName.trim().toUpperCase() === normalizedName
        );

        if (!entry) {
            throw new Error(`File "${fileName}" not found`);
        }

        // Free sector chain
        let track = entry.startTrack;
        let sector = entry.startSector;
        let count = 0;

        while (track !== 0 && count < 800) {
            const sectorOffset = D64._getTrackSectorOffset(track, sector);
            const nextTrack = this.data[sectorOffset];
            const nextSector = this.data[sectorOffset + 1];

            this._freeSector(track, sector);

            track = nextTrack;
            sector = nextSector;
            count++;
        }

        // Scratch directory entry
        let dirTrack = D64.DIR_TRACK;
        let dirSector = 1;

        while (dirTrack !== 0) {
            const sectorOffset = D64._getTrackSectorOffset(dirTrack, dirSector);

            for (let e = 0; e < 8; e++) {
                const entryOffset = sectorOffset + e * 32;
                if (this.data[entryOffset + 3] === entry.startTrack &&
                    this.data[entryOffset + 4] === entry.startSector) {
                    this.data[entryOffset + 2] = 0x00;
                    return true;
                }
            }

            dirTrack = this.data[sectorOffset];
            dirSector = this.data[sectorOffset + 1];
        }

        throw new Error('Could not find directory entry');
    }

    // =========================================================================
    // EXPORT
    // =========================================================================

    /**
     * Get disk data as a Blob for download
     * @returns {Blob}
     */
    toBlob() {
        return new Blob([this.data], { type: 'application/octet-stream' });
    }

    /**
     * Get raw disk data
     * @returns {Uint8Array}
     */
    getData() {
        return this.data;
    }

    // =========================================================================
    // PETSCII / FILENAME HELPERS
    // =========================================================================

    /**
     * Convert PETSCII filename bytes to JavaScript string.
     * 1541 filenames use a subset of PETSCII where uppercase A-Z (0x41-0x5A)
     * and digits (0x30-0x39) match ASCII. Padding byte 0xA0 (shifted space)
     * is converted to regular space and trimmed.
     *
     * Note: This handles disk filenames only. For GM's screen code character
     * set (used in program text), see c64lib.js decodeChar/decodeString.
     *
     * @param {Uint8Array} rawName - Raw PETSCII bytes
     * @returns {string} Decoded filename
     */
    static petsciiToString(rawName) {
        return String.fromCharCode(...rawName).replace(/\xA0/g, ' ').trim();
    }

    /**
     * Convert JavaScript string to PETSCII filename bytes.
     * Converts to uppercase and pads with 0xA0 to specified length.
     *
     * @param {string} str - String to convert
     * @param {number} length - Target length (default 16 for filenames)
     * @returns {Uint8Array} PETSCII bytes
     */
    static stringToPetscii(str, length = 16) {
        const result = new Uint8Array(length);
        const upper = str.toUpperCase();
        for (let i = 0; i < length; i++) {
            if (i < upper.length) {
                const code = upper.charCodeAt(i);
                // Uppercase letters and digits map directly
                result[i] = code;
            } else {
                result[i] = 0xA0;  // Pad with shifted space
            }
        }
        return result;
    }

    // Private alias for internal use
    static _parseFileName(rawName) {
        return D64.petsciiToString(rawName);
    }

    /**
     * Parse file type byte to string
     * @param {number} fileTypeByte - File type byte from directory entry
     * @returns {string} File type name (DEL, SEQ, PRG, USR, REL, UNK)
     */
    static parseFileType(fileTypeByte) {
        const types = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];
        const type = types[fileTypeByte & 0x07] || 'UNK';
        return (fileTypeByte & 0x80) ? type : 'DEL';
    }

    // Private alias for internal use
    static _parseFileType(fileTypeByte) {
        return D64.parseFileType(fileTypeByte);
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.D64 = D64;
}
