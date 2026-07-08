/**
 * gmDisk.js - GameMaker Disk Management Layer
 *
 * Wraps D64 (d64lib.js) with GM-specific functionality:
 * - localStorage persistence per page
 * - GM file type definitions (/SPR, /PIC, /SND, /SNG, /PRG)
 * - Unified popup UI for disk operations
 *
 * Usage:
 *   // Initialize (typically on page load)
 *   const disk = new GMDisk();
 *   disk.autoLoad();  // Load from localStorage if available
 *
 *   // Show file picker popup
 *   disk.showPopup({
 *       fileType: GMDisk.FILE_TYPES.SPRITE,
 *       onSelect: (fileName, data) => { ... }
 *   });
 *
 *   // Direct file operations
 *   const files = disk.listFiles(GMDisk.FILE_TYPES.SPRITE);
 *   const data = disk.loadFile('PLAYER/SPR');
 *   disk.saveFile('PLAYER/SPR', data);
 */

class GMDisk {
    // =========================================================================
    // FILE TYPE DEFINITIONS
    // =========================================================================

    static FILE_TYPES = {
        SPRITE:  { extension: '/SPR', label: 'Sprites',  filter: name => name.endsWith('/SPR') },
        SCENE:   { extension: '/PIC', label: 'Scenes',   filter: name => name.endsWith('/PIC') },
        SOUND:   { extension: '/SND', label: 'Sounds',   filter: name => name.endsWith('/SND') },
        MUSIC:   { extension: '/SNG', label: 'Music',    filter: name => name.endsWith('/SNG') },
        PROGRAM: { extension: '/PRG', label: 'Programs', filter: name => name.endsWith('/PRG') },
        ALL:     { extension: '',     label: 'All',      filter: () => true }
    };

    // Friendly singular type label shown in the directory's "type" column.
    static _typeLabel(ext) {
        switch ((ext || '').toUpperCase()) {
            case '/SPR': return 'sprite';
            case '/PIC': return 'scene';
            case '/SND': return 'sound';
            case '/SNG': return 'music';
            case '/PRG': return 'program';
            // Sentinel used when show-all groups extension-less standalone
            // exports. Not a real disk extension — just what the group's
            // rows display in the "type" column.
            case 'STANDALONE': return 'standalone';
            default:     return '';
        }
    }

    // GM's filename pattern: exactly 6 chars (space-padded if shorter) + slash
    // + 3-char known extension. This popup is a GM file finder, not a generic
    // disk browser, so anything else on the disk is silently skipped.
    static _isGmFile(fileName) {
        return /^.{6}\/(SPR|PIC|SND|SNG|PRG)$/i.test(fileName);
    }

    // Standalone GameMaker exports have no filename extension (single
    // words or numeric names like "ALIENS", "1", "2") but are distinguishable
    // by:
    //   - directory-entry block count of 191 (fixed size for the format)
    //   - load address $0302 in the first two bytes (the self-launching-
    //     via-IRQ-vector trick — no other C64 file type loads here)
    // Both checks are cheap: block count comes from the directory entry;
    // magic bytes require reading only the file's first sector.
    static _isStandaloneEntry(disk, entry) {
        if (entry.fileSize !== 191) return false;
        // getChainedData reads the whole chain — potentially ~48KB per call.
        // We only need the first two bytes, so limit to the start sector.
        // No public "read N bytes" method exists yet; the 191-block cost
        // per candidate is bearable given how few extension-less files
        // typically live on a GM disk.
        try {
            const data = disk.getChainedData(entry.startTrack, entry.startSector);
            return data && data.length >= 2 && data[0] === 0x02 && data[1] === 0x03;
        } catch (e) {
            return false;
        }
    }

    // Long disk filenames (uploaded .d64 files) can blow out the disk picker
    // layout. Collapse anything >30 chars to "first 20 … last 10" — keeps
    // the start (often the meaningful part) AND the tail (often a version
    // or unique suffix) while cutting boring middle.
    static _truncateDiskName(name) {
        if (!name || name.length <= 30) return name;
        return name.slice(0, 20) + '…' + name.slice(-10);
    }

    // =========================================================================
    // SHARED DISK POOL (static)
    // =========================================================================
    // All disks (inserted or created via Blank) live in a single shared pool in
    // localStorage. Each editor remembers which disk it's currently viewing.
    //
    // Storage layout:
    //   gm_disk_pool_index            JSON: [{id, name, diskName}, ...]
    //   gm_disk_pool_data_<id>        base64-encoded disk bytes per disk
    //   gm_disk_selection_<page>      id of disk currently selected by that tool

    static POOL_INDEX_KEY = 'gm_disk_pool_index';
    static POOL_DATA_PREFIX = 'gm_disk_pool_data_';
    static SELECTION_PREFIX = 'gm_disk_selection_';

    static _migrated = false;

    static getPool() {
        this._ensureMigrated();
        try {
            const raw = localStorage.getItem(this.POOL_INDEX_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    static _savePoolIndex(index) {
        localStorage.setItem(this.POOL_INDEX_KEY, JSON.stringify(index));
    }

    static _getDiskBytes(id) {
        const base64 = localStorage.getItem(this.POOL_DATA_PREFIX + id);
        if (!base64) return null;
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    static _putDiskBytes(id, bytes) {
        // String.fromCharCode.apply on a 174KB array blows the V8 arg limit, so
        // chunk it. 32KB chunks are well under the limit on every engine.
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        localStorage.setItem(this.POOL_DATA_PREFIX + id, btoa(binary));
    }

    static _newId() {
        return 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    static async _hashBytes(bytes) {
        const buffer = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /**
     * Backfill SHA-256 hashes for any pool entries that lack them (e.g. entries
     * migrated from the legacy per-tool storage layout, which was sync-only).
     */
    static async _ensureHashes() {
        const index = this.getPool();
        let changed = false;
        for (const entry of index) {
            if (entry.hash) continue;
            const bytes = this._getDiskBytes(entry.id);
            if (!bytes) continue;
            entry.hash = await this._hashBytes(bytes);
            changed = true;
        }
        if (changed) this._savePoolIndex(index);
    }

    /**
     * Add a disk to the pool, deduplicating by SHA-256 of the bytes. Returns the
     * id of the matching existing entry if one is found, otherwise the new id.
     */
    static async addToPool(bytes, name) {
        await this._ensureHashes();
        const hash = await this._hashBytes(bytes);

        const index = this.getPool();
        const existing = index.find(e => e.hash === hash);
        if (existing) return existing.id;

        const id = this._newId();
        const tempDisk = new D64(bytes);
        index.push({ id, name, diskName: tempDisk.getDiskName(), hash });
        this._putDiskBytes(id, bytes);
        this._savePoolIndex(index);
        return id;
    }

    /**
     * Remove a disk from the pool (global — affects all editors).
     */
    static removeFromPool(id) {
        const index = this.getPool().filter(e => e.id !== id);
        this._savePoolIndex(index);
        localStorage.removeItem(this.POOL_DATA_PREFIX + id);
    }

    /**
     * Update an existing pool entry's data and/or metadata.
     */
    static updatePoolEntry(id, { name, diskName, data } = {}) {
        const index = this.getPool();
        const entry = index.find(e => e.id === id);
        if (!entry) return;
        if (name !== undefined) entry.name = name;
        if (diskName !== undefined) entry.diskName = diskName;
        this._savePoolIndex(index);
        if (data !== undefined) this._putDiskBytes(id, data);
    }

    /**
     * One-time silent migration of legacy per-tool storage into the shared pool.
     * Legacy keys (gm_disk_<page>) are removed after migration.
     */
    static _ensureMigrated() {
        if (this._migrated) return;
        this._migrated = true;

        const pages = ['editor', 'sprite-maker', 'sound-maker', 'scene-maker', 'music-maker'];
        // Read the (recursive-safe) pool once; addToPool is async, so migration
        // must inline its work. Hashes are backfilled lazily by _ensureHashes.
        const index = this.getPool();
        let changed = false;
        for (const page of pages) {
            const dataKey = `gm_disk_${page}`;
            const nameKey = `${dataKey}_name`;
            const stored = localStorage.getItem(dataKey);
            if (!stored) continue;
            try {
                const binary = atob(stored);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const name = localStorage.getItem(nameKey) || `${page}.d64`;

                const id = this._newId();
                const tempDisk = new D64(bytes);
                index.push({ id, name, diskName: tempDisk.getDiskName() });
                this._putDiskBytes(id, bytes);

                localStorage.setItem(this.SELECTION_PREFIX + page, id);
                localStorage.removeItem(dataKey);
                localStorage.removeItem(nameKey);
                changed = true;
            } catch (e) {
                console.warn('GMDisk: legacy migration failed for', page, e.message);
            }
        }
        if (changed) this._savePoolIndex(index);
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a GMDisk instance
     * @param {Object} options
     * @param {string} options.selectionKey - per-tool selection key (default: auto from page name)
     * @param {HTMLElement} options.container - Container for popup (default: document.body)
     */
    constructor(options = {}) {
        const pageName = window.location.pathname.split('/').pop().replace('.html', '') || 'default';
        this.selectionKey = options.selectionKey || `${GMDisk.SELECTION_PREFIX}${pageName}`;

        this.container = options.container || document.body;

        // Current disk state — pointer into the shared pool
        this.disk = null;             // D64 instance for the currently-selected disk
        this.diskFileName = '';       // Original .d64 filename
        this.currentDiskId = null;    // Pool id of the currently-selected disk

        // Popup state
        this.popup = null;
        this.popupOptions = null;

        this.selectedIndex = -1;
        this.directoryEntries = [];

        // "Show all" toggle — when on, the file list includes all types, with
        // non-loadable types grayed-out and non-interactive. Persisted across
        // popup opens/closes so the user's preference sticks.
        this.showAll = localStorage.getItem('gm_disk_show_all') === '1';

        this._onKeyDown = this._onKeyDown.bind(this);
    }

    // =========================================================================
    // PERSISTENCE — backed by the shared pool
    // =========================================================================

    /**
     * Push the in-memory disk back to the pool entry it came from.
     */
    save() {
        if (!this.disk || !this.currentDiskId) return false;
        try {
            GMDisk.updatePoolEntry(this.currentDiskId, {
                diskName: this.disk.getDiskName(),
                data: this.disk.getData()
            });
            return true;
        } catch (e) {
            console.warn('GMDisk: Failed to save to pool:', e.message);
            return false;
        }
    }

    /**
     * Load this tool's selected disk from the pool. If the selection is stale
     * or absent, falls back to the first disk in the pool.
     * @returns {boolean} true if a disk was loaded
     */
    load() {
        const savedId = localStorage.getItem(this.selectionKey);
        if (savedId && this.selectDisk(savedId)) return true;

        // Stale or missing selection — fall back to first disk in pool
        const pool = GMDisk.getPool();
        if (pool.length > 0) return this.selectDisk(pool[0].id);

        // Pool empty
        this.disk = null;
        this.diskFileName = '';
        this.currentDiskId = null;
        localStorage.removeItem(this.selectionKey);
        return false;
    }

    /**
     * Switch this tool to a different disk from the pool.
     * @returns {boolean} true if the disk was loaded successfully
     */
    selectDisk(id) {
        const entry = GMDisk.getPool().find(e => e.id === id);
        if (!entry) return false;
        const bytes = GMDisk._getDiskBytes(id);
        if (!bytes) return false;
        try {
            this.disk = new D64(bytes);
            this.diskFileName = entry.name;
            this.currentDiskId = id;
            localStorage.setItem(this.selectionKey, id);
            return true;
        } catch (e) {
            console.warn('GMDisk: Failed to instantiate D64:', e.message);
            return false;
        }
    }

    /**
     * Re-read the current disk's bytes from the shared pool, replacing
     * the in-memory D64 instance. Use this when another editor might
     * have written to the same disk (saved a sprite, scene, etc.) and
     * our cached `this.disk` would otherwise miss the new files.
     */
    refresh() {
        if (this.currentDiskId) this.selectDisk(this.currentDiskId);
    }

    /**
     * Eject the current disk: removes it from the shared pool (affects every
     * editor that was viewing it) and snaps this tool to the next available
     * disk in the pool (or no-disk if the pool is empty).
     */
    clear() {
        if (this.currentDiskId) {
            GMDisk.removeFromPool(this.currentDiskId);
        }
        this.currentDiskId = null;
        this.disk = null;
        this.diskFileName = '';
        localStorage.removeItem(this.selectionKey);

        // Snap to next available disk
        const pool = GMDisk.getPool();
        if (pool.length > 0) this.selectDisk(pool[0].id);
    }

    /**
     * Create a fresh blank disk, add it to the pool, and select it.
     * A random disk id is used so that clicking Blank D64 twice in a row
     * produces two distinct disks (otherwise the SHA-256 dedup would collapse
     * deterministic blank-disk bytes into a single pool entry).
     */
    async createBlank(name = null, diskId = null) {
        // Default to a unique auto-numbered name ("NEW DISK 01", "NEW DISK 02",
        // …) so successive Blank-Disk clicks don't pile up identically-named
        // files. Explicit names (passed by callers) pass through untouched.
        const useName = name || `NEW DISK ${String(GMDisk._nextNewDiskNumber()).padStart(2, '0')}`;
        const id2 = diskId || GMDisk._randomDiskId();
        const d64 = D64.createEmpty(useName, id2);
        const safeName = (useName.replace(/[^A-Z0-9 ]/gi, '').trim().toUpperCase() || 'NEW') + '.d64';
        const poolId = await GMDisk.addToPool(d64.getData(), safeName);
        this.selectDisk(poolId);
    }

    // Walk the pool looking for "NEW DISK NN" entries and return max+1. Used
    // by createBlank when no explicit name is passed. Counts both pool
    // filenames ("NEW DISK 03.d64") and disk names ("NEW DISK 03") so a
    // rename of either side still bumps the next auto-number correctly.
    static _nextNewDiskNumber() {
        const pool = GMDisk.getPool();
        let max = 0;
        const filenameRe = /^NEW DISK (\d+)\.d64$/i;
        const diskNameRe = /^NEW DISK (\d+)$/i;
        for (const entry of pool) {
            const m = (entry.name || '').match(filenameRe)
                  || (entry.diskName || '').match(diskNameRe);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max + 1;
    }

    static _randomDiskId() {
        const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        return chars[Math.floor(Math.random() * chars.length)] + chars[Math.floor(Math.random() * chars.length)];
    }

    /**
     * Auto-load on page open — selects this tool's last-used disk, or the
     * first disk in the pool if none was previously selected.
     */
    autoLoad() {
        return this.load();
    }

    // =========================================================================
    // DISK OPERATIONS
    // =========================================================================

    /**
     * Check if a disk is loaded
     */
    hasDisk() {
        return this.disk !== null;
    }

    /**
     * Get disk name
     */
    getDiskName() {
        return this.disk ? this.disk.getDiskName() : '';
    }

    /**
     * Get free blocks
     */
    getFreeBlocks() {
        return this.disk ? this.disk.getFreeBlocks() : 0;
    }

    /**
     * List files, optionally filtered by type
     * @param {Object} fileType - One of GMDisk.FILE_TYPES (optional)
     * @returns {Array} Array of directory entries
     */
    listFiles(fileType = null) {
        if (!this.disk) return [];

        const entries = this.disk.getDirectory();
        if (!fileType || fileType === GMDisk.FILE_TYPES.ALL) {
            return entries;
        }
        return entries.filter(e => fileType.filter(e.fileName));
    }

    /**
     * Load a file by name
     * @param {string} fileName
     * @returns {Uint8Array|null}
     */
    loadFile(fileName) {
        if (!this.disk) return null;
        return this.disk.readFile(fileName);
    }

    /**
     * Save a file to disk
     * @param {string} fileName
     * @param {Uint8Array} data
     * @param {boolean} overwrite - Delete existing file first (default: true)
     * @returns {boolean}
     */
    saveFile(fileName, data, overwrite = true) {
        if (!this.disk) return false;

        try {
            // Check if file exists
            const existing = this.disk.getDirectory().find(
                e => e.fileName.trim().toUpperCase() === fileName.trim().toUpperCase()
            );

            if (existing) {
                if (overwrite) {
                    this.disk.deleteFile(fileName);
                } else {
                    throw new Error(`File "${fileName}" already exists`);
                }
            }

            this.disk.writeFile(fileName, data, D64.FILE_TYPE_PRG);
            this.save();  // Persist to localStorage
            return true;
        } catch (e) {
            console.error('GMDisk: saveFile failed:', e.message);
            return false;
        }
    }

    /**
     * Delete a file
     * @param {string} fileName
     * @returns {boolean}
     */
    deleteFile(fileName) {
        if (!this.disk) return false;

        try {
            this.disk.deleteFile(fileName);
            this.save();
            return true;
        } catch (e) {
            console.error('GMDisk: deleteFile failed:', e.message);
            return false;
        }
    }

    /**
     * Download disk as .d64 file
     * @param {string} filename - Download filename (default: original name or 'disk.d64')
     */
    download(filename = null) {
        if (!this.disk) return;

        const downloadName = filename || this.diskFileName || 'disk.d64';
        const blob = this.disk.toBlob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // FILE INPUT HANDLING
    // =========================================================================

    /**
     * Load a D64 from a File object (from file input)
     * @param {File} file
     * @returns {Promise<boolean>}
     */
    async loadFromFile(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const bytes = new Uint8Array(e.target.result);
                    new D64(bytes); // validate
                    const ok = await this._insertBytes(bytes, file.name);
                    resolve(ok);
                } catch (err) {
                    console.error('GMDisk: Failed to load D64:', err.message);
                    resolve(false);
                }
            };
            reader.onerror = () => resolve(false);
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Insert bytes into the pool with collision handling. Returns true if a disk
     * was selected (whether by adding or by switching to an existing entry).
     *
     * - same hash → silent dedup (select existing)
     * - different hash, same filename → prompt "Replace existing X.d64? yes/no"
     * - different hash, different filename → add as new
     */
    async _insertBytes(bytes, fileName) {
        await GMDisk._ensureHashes();
        const hash = await GMDisk._hashBytes(bytes);
        const pool = GMDisk.getPool();

        const hashMatch = pool.find(e => e.hash === hash);
        if (hashMatch) {
            this.selectDisk(hashMatch.id);
            this._updatePopupDirectory();
            return true;
        }

        const nameMatch = pool.find(e => e.name === fileName);
        if (nameMatch) {
            const replace = await this._askReplace(fileName);
            if (!replace) return false;
            GMDisk.removeFromPool(nameMatch.id);
        }

        const id = await GMDisk.addToPool(bytes, fileName);
        this.selectDisk(id);
        this._updatePopupDirectory();
        return true;
    }

    // =========================================================================
    // POPUP UI
    // =========================================================================

    /**
     * Show the disk popup
     * @param {Object} options
     * @param {Object} options.fileType - GMDisk.FILE_TYPES value (default: ALL)
     * @param {Function} options.onSelect - Callback(fileName, data) when file selected
     * @param {Function} options.onClose - Callback when popup closed
     * @param {boolean} options.showSave - Show save button (default: false)
     * @param {Function} options.onSave - Callback for save button
     * @param {string} options.title - Popup title (default: 'D64 Disk')
     * @param {Array} options.customButtons - Array of {label, onClick} for page-specific actions
     */
    showPopup(options = {}) {
        this.popupOptions = {
            fileType: options.fileType || GMDisk.FILE_TYPES.ALL,
            onSelect: options.onSelect || null,
            onClose: options.onClose || null,
            showSave: options.showSave || false,
            onSave: options.onSave || null,
            title: options.title || 'D64 Disk Drive',
            customButtons: options.customButtons || [],
            suggestedSaveName: options.suggestedSaveName || null
        };

        this._createPopup();
        this._updatePopupDirectory();

        // Keyboard handler runs in CAPTURE phase. Editor pages have their
        // own bubble-phase window keydown listeners that interpret arrow
        // keys as program-editor navigation; without capture we'd fire
        // last (they registered first) and the editor would see keys
        // pressed inside the popup. With capture we run first and
        // stopImmediatePropagation in the handler kills the leak.
        window.addEventListener('keydown', this._onKeyDown, { capture: true });
    }

    /**
     * Close the popup
     */
    closePopup() {
        // Close any active prompt first so its document-level
        // outside-mousedown listener gets unregistered (and any
        // awaiting Promise — e.g. _askReplace — resolves).
        if (this._activePrompt) this._activePrompt.restore();

        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }

        window.removeEventListener('keydown', this._onKeyDown, { capture: true });
        this.selectedIndex = -1;
        this.directoryEntries = [];

        if (this.popupOptions?.onClose) {
            this.popupOptions.onClose();
        }
        this.popupOptions = null;
    }

    // =========================================================================
    // POPUP INTERNALS
    // =========================================================================

    _createPopup() {
        // Remove existing popup if any
        if (this.popup) {
            this.popup.remove();
        }

        // Build custom buttons HTML
        const customBtnHtml = this.popupOptions.customButtons
            .map((btn, i) => `<button class="gm-disk-custom" data-custom-index="${i}">${btn.label}</button>`)
            .join('');

        // Create overlay (uses standard classes from c64-ui.css)
        this.popup = document.createElement('div');
        this.popup.className = 'popup-overlay';
        this.popup.innerHTML = `
            <div class="popup-dialog gm-disk-dialog">
                <button class="gm-disk-close popup-close-x">X</button>
                <div class="popup-title">${this.popupOptions.title}</div>
                <div class="gm-disk-disk-row">
                    <button class="gm-disk-insert">Insert Disk</button>
                    <button class="gm-disk-blank">New Disk</button>
                    <button class="gm-disk-rename">Rename Disk</button>
                    <button class="gm-disk-eject">Eject</button>
                </div>
                <input type="file" class="gm-disk-file-input" accept=".d64" style="display:none">
                <div class="gm-disk-message-bar">
                    <!-- All prompts share .gm-disk-prompt for the yellow-text
                         + flex-1 + chip styling. They're mutually exclusive:
                         only one is visible at a time, managed by _openPrompt. -->
                    <span class="gm-disk-prompt gm-disk-overwrite-prompt" hidden>
                        overwrite? <a class="gm-disk-overwrite-yes">yes</a>&nbsp;&nbsp;<a class="gm-disk-overwrite-no">no</a>
                    </span>
                    <span class="gm-disk-prompt gm-disk-replace-prompt" hidden>
                        <span class="gm-disk-replace-text"></span>&nbsp;<a class="gm-disk-replace-yes">yes</a>&nbsp;&nbsp;<a class="gm-disk-replace-no">no</a>
                    </span>
                    <span class="gm-disk-prompt gm-disk-delete-prompt" hidden>
                        delete? <a class="gm-disk-delete-yes">yes</a>&nbsp;&nbsp;<a class="gm-disk-delete-no">no</a>
                    </span>
                    <span class="gm-disk-prompt gm-disk-eject-prompt" hidden>
                        eject? <a class="gm-disk-eject-yes">yes</a>&nbsp;&nbsp;<a class="gm-disk-eject-no">no</a>
                    </span>
                    <!-- Shared name-prompt: used by both Rename Disk and New
                         Disk. The triggering button gets an .active highlight
                         while the prompt is open and stands in for any "you're
                         in this mode" label. -->
                    <span class="gm-disk-prompt gm-disk-prompt--form gm-disk-name-prompt" hidden>
                        <input type="text" class="gm-disk-name-prompt-input" maxlength="40" autocomplete="off" spellcheck="false">
                        <span class="gm-disk-name-prompt-actions">
                            <a class="gm-disk-name-prompt-ok">ok</a>&nbsp;&nbsp;<a class="gm-disk-name-prompt-cancel">cancel</a>
                        </span>
                    </span>
                    <span class="gm-disk-info-message" hidden></span>
                </div>
                <div class="info-bar">
                    <div class="gm-disk-name">
                        <span class="gm-disk-filename">No disk loaded</span>
                        <span class="gm-disk-free"></span>
                    </div>
                </div>
                <div class="file-list-container">
                    <table class="file-list">
                        <thead class="file-list-head">
                            <tr>
                                <th class="file-list-header-name">filename</th>
                                <th class="file-list-header-type">type</th>
                                <th class="file-list-header-blocks">blocks</th>
                            </tr>
                        </thead>
                        <tbody class="gm-disk-files"></tbody>
                    </table>
                </div>
                <!-- File-scoped actions row, directly under the listing.
                     Delete is left-aligned (destructive — kept away from the
                     constructive controls). Load + filename + Save are
                     pushed to the right as the "save-and-load" cluster. -->
                <div class="gm-disk-file-actions-row">
                    <button class="gm-disk-delete" disabled>Delete</button>
                    <button class="gm-disk-load gm-disk-actions-right" disabled>Load</button>
                    ${this.popupOptions.showSave ? `
                    <input type="text" class="gm-disk-name-input" maxlength="6" placeholder="filename" autocomplete="off" spellcheck="false">
                    <button class="gm-disk-save">Save</button>` : ''}
                </div>
                <div class="popup-buttons-bottom">
                    <div class="popup-buttons-left">
                        <!-- Show All is a list filter, not a whole-disk action —
                             parked above Download D64 as the closest visually
                             neutral spot. Sized down a notch so it reads as
                             secondary to the main bottom buttons. -->
                        <button class="gm-disk-show-all">Show All File Types</button>
                        <button class="gm-disk-download">Download D64</button>
                    </div>
                    <div class="popup-buttons-right">
                        ${customBtnHtml}
                    </div>
                </div>
            </div>
        `;

        // Wire up events
        const fileInput = this.popup.querySelector('.gm-disk-file-input');
        const insertBtn = this.popup.querySelector('.gm-disk-insert');
        const blankBtn = this.popup.querySelector('.gm-disk-blank');
        const renameBtn = this.popup.querySelector('.gm-disk-rename');
        const ejectBtn = this.popup.querySelector('.gm-disk-eject');
        const saveBtn = this.popup.querySelector('.gm-disk-save');
        const downloadBtn = this.popup.querySelector('.gm-disk-download');
        const closeBtn = this.popup.querySelector('.gm-disk-close');

        insertBtn.onclick = () => {
            // Dismiss any active prompt before opening the OS file
            // picker (we'd otherwise leave it visible behind the picker
            // with its trigger button still highlighted).
            this._activePrompt?.restore();
            fileInput.click();
        };
        fileInput.onclick = () => { fileInput.value = ''; };  // Allow re-selecting same file
        fileInput.onchange = async (e) => {
            if (e.target.files[0]) {
                await this.loadFromFile(e.target.files[0]);
                this._updatePopupDirectory();
            }
        };

        blankBtn.onclick = () => this._showNewDiskPrompt();
        renameBtn.onclick = () => this._showRenamePrompt();

        ejectBtn.onclick = () => this._showEjectPrompt();

        if (saveBtn) {
            const input = this.popup.querySelector('.gm-disk-name-input');

            // Pre-fill with the tool's current filename if provided
            const suggested = this.popupOptions.suggestedSaveName;
            if (suggested) {
                const raw = typeof suggested === 'function' ? suggested() : suggested;
                input.value = this._baseNameForInput(raw);
            }

            // Hard-constrain input: lowercase, [a-z0-9 ], 6 chars
            input.addEventListener('input', () => {
                const cleaned = input.value.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 6);
                if (input.value !== cleaned) input.value = cleaned;
            });

            // Enter in the input triggers save
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._triggerSave();
                }
            });

            saveBtn.onclick = () => this._triggerSave();
        }

        downloadBtn.onclick = () => this.download();
        closeBtn.onclick = () => this.closePopup();

        // Per-file action buttons. Disabled until the user selects a row.
        const loadBtn = this.popup.querySelector('.gm-disk-load');
        const deleteBtn = this.popup.querySelector('.gm-disk-delete');
        loadBtn.onclick = () => this._loadSelected();
        deleteBtn.onclick = () => this._promptDelete();

        // Show-all toggle — flips between filtered listing (just the editor's
        // primary file type) and the full disk contents (with non-loadable
        // types grayed-out and non-interactive).
        const showAllBtn = this.popup.querySelector('.gm-disk-show-all');
        showAllBtn.classList.toggle('active', this.showAll);
        showAllBtn.onclick = () => {
            this.showAll = !this.showAll;
            localStorage.setItem('gm_disk_show_all', this.showAll ? '1' : '0');
            showAllBtn.classList.toggle('active', this.showAll);
            this._updatePopupDirectory();
        };

        // Wire up custom buttons
        const customBtns = this.popup.querySelectorAll('.gm-disk-custom');
        customBtns.forEach(btn => {
            const index = parseInt(btn.dataset.customIndex);
            btn.onclick = () => {
                const customBtn = this.popupOptions.customButtons[index];
                if (customBtn && customBtn.onClick) {
                    customBtn.onClick();
                }
            };
        });

        // Close on overlay click (but not dialog click)
        this.popup.onclick = (e) => {
            if (e.target === this.popup) {
                this.closePopup();
            }
        };

        this.container.appendChild(this.popup);
    }

    // Strip the fileType extension from a filename so it's safe to put in the input.
    // Accepts either "PLAYER" or "PLAYER/SPR" or "  PLAYER/SPR".
    _baseNameForInput(name) {
        if (!name) return '';
        const ext = this.popupOptions.fileType && this.popupOptions.fileType.extension;
        let s = String(name);
        if (ext && s.toUpperCase().endsWith(ext)) {
            s = s.substring(0, s.length - ext.length);
        }
        return s.toLowerCase().trim().substring(0, 6);
    }

    _triggerSave() {
        if (!this.hasDisk()) {
            this.showInfoMessage('Insert a disk first');
            return;
        }
        const input = this.popup.querySelector('.gm-disk-name-input');
        // Don't trim — internal whitespace can be significant in GM filenames.
        // We only need a non-empty (after trim) check to reject blank input.
        const name = input.value;
        if (!name.trim()) {
            input.focus();
            return;
        }
        const ext = (this.popupOptions.fileType && this.popupOptions.fileType.extension) || '';
        const extNoSlash = ext.replace(/^\//, '');
        const fileName = extNoSlash
            ? GMTools.formatFileName(name, extNoSlash)
            : name.toUpperCase();

        // Check for existing file on disk
        const exists = this.listFiles().some(
            e => e.fileName.trim().toUpperCase() === fileName.toUpperCase()
        );

        if (exists) {
            this._showOverwritePrompt(fileName);
        } else {
            this._doSave(fileName);
        }
    }

    _doSave(fileName) {
        // Save is a terminal action — close the popup on success so the user
        // gets back to whatever they were doing. On failure, leave the popup
        // open so the failure info-message (set by the callback) stays visible.
        // Callbacks should return true on success.
        const ok = this.popupOptions.onSave
            ? !!this.popupOptions.onSave(fileName)
            : true;
        this._updatePopupDirectory();
        if (ok) {
            this.closePopup();
            window.gmc64Telemetry && window.gmc64Telemetry.logEvent('file_saved');
        }
    }

    /**
     * Show a temporary informational message in the disk info-bar (replaces
     * the disk-name + free spans). Auto-clears after `duration` ms. For real
     * flashing-color alarms, see GMTools.flashingMessage.
     *
     * @param {string} text - Message text
     * @param {Object} options
     * @param {number} options.duration - ms before auto-clear (default 2500; 0 = sticky)
     * @param {string} options.color - CSS color (default var(--c64-red))
     */
    showInfoMessage(text, options = {}) {
        if (!this.popup) return;
        // Don't clobber an active prompt — the message bar is exclusive.
        if (this._activePrompt) return;
        const msg = this.popup.querySelector('.gm-disk-info-message');

        if (this._messageTimer) {
            clearTimeout(this._messageTimer);
            this._messageTimer = null;
        }

        msg.hidden = false;
        msg.textContent = text;
        msg.style.color = options.color || 'var(--c64-red)';

        const duration = options.duration !== undefined ? options.duration : 2500;
        if (duration > 0) {
            this._messageTimer = setTimeout(() => this.clearMessage(), duration);
        }
    }

    clearMessage() {
        if (!this.popup) return;
        const msg = this.popup.querySelector('.gm-disk-info-message');
        if (this._messageTimer) {
            clearTimeout(this._messageTimer);
            this._messageTimer = null;
        }
        msg.hidden = true;
        msg.textContent = '';
    }

    // === SHARED PROMPT INFRASTRUCTURE ===
    //
    // Every message-bar prompt (overwrite, replace, delete, eject, name)
    // goes through _openPrompt so they all behave identically:
    //   - Mutually exclusive — opening one closes any other.
    //   - Outside-mousedown cancels (clicks anywhere not inside the
    //     prompt itself; capture phase, so it fires before chip
    //     onclicks which means inside-prompt clicks reach their handlers
    //     unhindered).
    //   - Optional triggerBtn gets .active highlight while open.
    //   - Returns restore(); caller wires yes/no/ok onclicks to call it
    //     after running the confirm action.
    //
    // The single this._activePrompt field replaces what used to be four
    // separate per-prompt restore/listener fields. closePopup, the Escape
    // handler, and Insert Disk all just use this._activePrompt?.restore().
    _openPrompt({ promptEl, triggerBtn = null }) {
        if (this._activePrompt) this._activePrompt.restore();

        promptEl.hidden = false;
        if (triggerBtn) triggerBtn.classList.add('active');

        const onOutsideMouseDown = (e) => {
            // Clicks inside any prompt element (input, chips) don't
            // dismiss — they belong to the prompt's own handlers.
            if (e.target.closest('.gm-disk-prompt')) return;
            restore();
        };
        document.addEventListener('mousedown', onOutsideMouseDown, true);

        const restore = () => {
            promptEl.hidden = true;
            if (triggerBtn) triggerBtn.classList.remove('active');
            document.removeEventListener('mousedown', onOutsideMouseDown, true);
            this._activePrompt = null;
        };
        this._activePrompt = { restore };
        return restore;
    }

    _showOverwritePrompt(fileName) {
        const prompt = this.popup.querySelector('.gm-disk-overwrite-prompt');
        const yes = prompt.querySelector('.gm-disk-overwrite-yes');
        const no = prompt.querySelector('.gm-disk-overwrite-no');
        const restore = this._openPrompt({ promptEl: prompt });
        yes.onclick = () => { restore(); this._doSave(fileName); };
        no.onclick  = () => restore();
    }

    // Eject removes the disk from the pool — destructive if the user
    // hasn't downloaded it first. Button stays highlighted while the
    // prompt is open (matches the rename / new-disk mode-indicator
    // pattern).
    _showEjectPrompt() {
        if (!this.currentDiskId) return;
        const prompt = this.popup.querySelector('.gm-disk-eject-prompt');
        const yes = prompt.querySelector('.gm-disk-eject-yes');
        const no = prompt.querySelector('.gm-disk-eject-no');
        const restore = this._openPrompt({
            promptEl: prompt,
            triggerBtn: this.popup.querySelector('.gm-disk-eject')
        });
        yes.onclick = () => {
            restore();
            this.clear();
            this._updatePopupDirectory();
        };
        no.onclick = () => restore();
    }

    // Shared name-prompt: text input + ok/cancel in the message bar.
    // Used by Rename Disk and New Disk — same UX shape, different
    // onOk callback and triggering button. The triggering button gets
    // an `.active` highlight while the prompt is open, so it doubles
    // as the "you're in this mode" indicator (no separate label text
    // needed in the message bar). Pre-fills + selects the initialValue
    // so the user can confirm with Enter or replace by typing.
    _showNamePrompt({ initialValue, onOk, triggerBtn }) {
        const prompt = this.popup.querySelector('.gm-disk-name-prompt');
        const input  = prompt.querySelector('.gm-disk-name-prompt-input');
        const okBtn  = prompt.querySelector('.gm-disk-name-prompt-ok');
        const cancel = prompt.querySelector('.gm-disk-name-prompt-cancel');

        input.value = initialValue || '';
        const restore = this._openPrompt({ promptEl: prompt, triggerBtn });
        input.focus();
        input.select();

        const confirm = () => {
            const name = input.value.trim();
            restore();
            if (!name) return;
            onOk(name);
        };
        okBtn.onclick  = confirm;
        cancel.onclick = () => restore();
        input.onkeydown = (e) => {
            if (e.key === 'Enter')       { e.preventDefault(); confirm(); }
            else if (e.key === 'Escape') { e.preventDefault(); restore(); }
        };
    }

    _showRenamePrompt() {
        if (!this.disk || !this.currentDiskId) {
            this.showInfoMessage('No disk loaded');
            return;
        }
        // Pre-fill with the current filename (sans .d64 — we add it back
        // on confirm so the user doesn't have to type/keep the extension).
        const entry = GMDisk.getPool().find(e => e.id === this.currentDiskId);
        this._showNamePrompt({
            initialValue: entry ? entry.name.replace(/\.d64$/i, '') : '',
            onOk: (newName) => this._renameCurrentDisk(newName),
            triggerBtn: this.popup.querySelector('.gm-disk-rename')
        });
    }

    _showNewDiskPrompt() {
        // Suggest the next auto-numbered name — user can accept (Enter) for
        // the fast scratch-disk path or type a meaningful name instead.
        const suggested = `NEW DISK ${String(GMDisk._nextNewDiskNumber()).padStart(2, '0')}`;
        this._showNamePrompt({
            initialValue: suggested,
            onOk: async (name) => {
                await this.createBlank(name);
                this._updatePopupDirectory();
            },
            triggerBtn: this.popup.querySelector('.gm-disk-blank')
        });
    }

    // Apply a new filename to the current pool entry. Strips filesystem-
    // unsafe chars (slash, colon, etc.) and ensures the .d64 extension is
    // present exactly once. Disk bytes / BAM are untouched — this is a
    // pure metadata rename.
    _renameCurrentDisk(newName) {
        if (!this.currentDiskId) return;
        const safe = newName.replace(/[\/\\:*?"<>|]/g, '').trim() || 'NEW';
        const safeFile = /\.d64$/i.test(safe) ? safe : safe + '.d64';
        GMDisk.updatePoolEntry(this.currentDiskId, { name: safeFile });
        // Keep the in-memory cached filename in sync — download() and the
        // editor's "from disk: …" hint both read diskFileName, so without
        // this they'd keep showing the pre-rename name until reload.
        this.diskFileName = safeFile;
        this._updatePopupDirectory();
    }

    _askReplace(fileName) {
        return new Promise((resolve) => {
            const prompt = this.popup.querySelector('.gm-disk-replace-prompt');
            const text = prompt.querySelector('.gm-disk-replace-text');
            const yes = prompt.querySelector('.gm-disk-replace-yes');
            const no = prompt.querySelector('.gm-disk-replace-no');

            text.textContent = `Replace existing ${fileName}?`;
            const baseRestore = this._openPrompt({ promptEl: prompt });

            // Single resolution path. The promise MUST resolve exactly
            // once (addToPool awaits us). Any dismissal — yes/no chip,
            // outside-click, Escape, popup close — routes through here.
            let resolved = false;
            const finish = (answer) => {
                if (resolved) return;
                resolved = true;
                baseRestore();
                resolve(answer);
            };
            // Patch the active prompt's restore so external closers
            // (outside-click, Escape, popup-close) resolve as "no".
            this._activePrompt.restore = () => finish(false);
            yes.onclick = () => finish(true);
            no.onclick  = () => finish(false);
        });
    }


    /**
     * Refresh the popup directory listing (public wrapper)
     */
    refreshPopup() {
        this._updatePopupDirectory();
    }

    /**
     * Attach the shared-pool disk picker to the disk-name element. Idempotent —
     * safe to call on every refresh. Uses GMTools.draggableField so behaviour
     * matches every other dropdown in the suite.
     */
    _wireDiskPicker(nameEl) {
        if (typeof GMTools === 'undefined' || !GMTools.draggableField) return;

        const pool = GMDisk.getPool();
        const ids = pool.map(e => e.id);

        GMTools.draggableField.attach(nameEl, {
            type: 'enum',
            values: ids,
            getValue: () => this.currentDiskId,
            setValue: (id) => {
                this.selectDisk(id);
                this._updatePopupDirectory();
            },
            // Used for typed-search matching (e.g. user types "game" to filter)
            formatValue: (id) => {
                const entry = GMDisk.getPool().find(e => e.id === id);
                return entry ? entry.name : '';
            },
            // Dropdown entry mirrors the resting display: filename (left,
            // truncated if long) and "N free" (right).
            renderItem: (id) => {
                const entry = GMDisk.getPool().find(e => e.id === id);
                if (!entry) return '';

                const wrap = document.createElement('div');
                wrap.className = 'gm-disk-item';

                const filename = document.createElement('span');
                filename.className = 'gm-disk-filename';
                filename.textContent = GMDisk._truncateDiskName(entry.name);

                const free = document.createElement('span');
                free.className = 'gm-disk-free';
                const bytes = GMDisk._getDiskBytes(id);
                if (bytes) {
                    try {
                        free.textContent = `${new D64(bytes).getFreeBlocks()} free`;
                    } catch (e) { /* leave blank */ }
                }

                wrap.appendChild(filename);
                wrap.appendChild(free);
                return wrap;
            }
        });

        // Picker reads as a button — pointer cursor over the draggable default
        nameEl.style.cursor = 'pointer';
    }

    _updatePopupDirectory() {
        if (!this.popup) return;

        const nameEl = this.popup.querySelector('.gm-disk-name');
        const filenameEl = this.popup.querySelector('.gm-disk-filename');
        const freeEl = this.popup.querySelector('.gm-disk-free');
        const tbody = this.popup.querySelector('.gm-disk-files');

        this._wireDiskPicker(nameEl);

        if (!this.disk) {
            filenameEl.textContent = 'No disk loaded';
            freeEl.textContent = '';
            tbody.innerHTML = '<tr class="gm-disk-empty"><td colspan="3">Insert a disk to browse files</td></tr>';
            this.directoryEntries = [];
            return;
        }

        const entry = GMDisk.getPool().find(e => e.id === this.currentDiskId);
        filenameEl.textContent = GMDisk._truncateDiskName(entry ? entry.name : '');
        freeEl.textContent = `${this.getFreeBlocks()} free`;

        // Build the unified entry list. Every row is selectable (so Delete
        // can work on any type), but only the editor's primary type is
        // LOADable — non-primary entries in show-all mode get marked
        // dimmed and the Load button stays disabled when one is selected.
        // Files that don't match GM's filename shape are skipped entirely —
        // this popup is a GM finder, not a generic disk browser.
        const primaryFiles = this.listFiles(this.popupOptions.fileType)
            .filter(e => GMDisk._isGmFile(e.fileName));

        let groups;
        if (this.showAll) {
            // Group all GM-shaped files by extension. Primary type leads;
            // remaining groups follow in this fixed order (chosen by frequency
            // of use — sprites are usually the bulk of a disk, programs the
            // smallest count).
            const TYPE_ORDER = ['/SPR', '/PIC', '/SND', '/SNG', '/PRG'];
            const rawAll = this.listFiles();
            const all = rawAll.filter(e => GMDisk._isGmFile(e.fileName));
            const primaryExt = (this.popupOptions.fileType.extension || '').toUpperCase();
            const byExt = {};
            for (const entry of all) {
                const slash = entry.fileName.lastIndexOf('/');
                const ext = slash >= 0 ? entry.fileName.substring(slash).toUpperCase() : '';
                if (!byExt[ext]) byExt[ext] = [];
                byExt[ext].push(entry);
            }
            const otherExts = TYPE_ORDER.filter(ext => byExt[ext] && ext !== primaryExt);
            // Scan the remaining (non-GM-named) entries for standalones.
            // They have no /XXX suffix so _isGmFile filters them out above,
            // but the block-count + magic-byte check picks them up here.
            const standalones = rawAll.filter(e =>
                !GMDisk._isGmFile(e.fileName) && GMDisk._isStandaloneEntry(this.disk, e));
            groups = [];
            if (byExt[primaryExt]) groups.push({ entries: byExt[primaryExt], loadable: true });
            for (const ext of otherExts) groups.push({ entries: byExt[ext], loadable: false });
            // Standalones are clickable and loadable — the host detects the
            // $0302 magic on the raw bytes and routes through standaloneToPRG.
            if (standalones.length) {
                groups.push({ entries: standalones, loadable: true, ext: 'STANDALONE' });
            }
        } else {
            groups = [{ entries: primaryFiles, loadable: true }];
        }

        // Flatten groups into directoryEntries (single source of truth) and
        // render. Each entry carries its loadable flag so click/select logic
        // can decide which buttons to enable.
        this.directoryEntries = [];
        for (const g of groups) {
            for (const e of g.entries) {
                this.directoryEntries.push({ ...e, loadable: g.loadable });
            }
        }

        // Build table. Single click selects (highlight + prefill save name);
        // double click is the shortcut for load.
        tbody.innerHTML = '';
        let index = 0;
        groups.forEach((group, groupIdx) => {
            // Visual gap between groups in show-all mode — a thin spacer row.
            if (groupIdx > 0) {
                const spacer = document.createElement('tr');
                spacer.className = 'gm-disk-group-gap';
                spacer.innerHTML = '<td colspan="3">&nbsp;</td>';
                tbody.appendChild(spacer);
            }
            group.entries.forEach((entry) => {
                const row = document.createElement('tr');
                row.dataset.fileName = entry.fileName;
                const myIndex = index++;
                row.dataset.index = myIndex;
                row.onclick = () => this._highlightFile(myIndex);
                if (group.loadable) {
                    row.ondblclick = () => this._loadSelected();
                } else {
                    row.classList.add('gm-disk-row-dimmed');
                }

                // Split "PLAYER/SPR" → "PLAYER" + "sprite". The full filename
                // with extension is still the canonical identifier in code
                // (and on row.dataset.fileName); the split here is purely
                // presentational. Standalones have no extension; the group
                // carries a synthetic `ext: 'STANDALONE'` marker so the
                // type cell can still label them.
                const slash = entry.fileName.lastIndexOf('/');
                const baseName = slash >= 0 ? entry.fileName.substring(0, slash) : entry.fileName;
                const ext = group.ext || (slash >= 0 ? entry.fileName.substring(slash).toUpperCase() : '');

                const nameCell = document.createElement('td');
                nameCell.textContent = baseName;

                const typeCell = document.createElement('td');
                typeCell.textContent = GMDisk._typeLabel(ext);

                const sizeCell = document.createElement('td');
                sizeCell.textContent = entry.fileSize;

                row.appendChild(nameCell);
                row.appendChild(typeCell);
                row.appendChild(sizeCell);
                tbody.appendChild(row);
            });
        });

        if (primaryFiles.length === 0 && !this.showAll) {
            tbody.innerHTML = `<tr class="gm-disk-empty"><td colspan="3">No ${this.popupOptions.fileType.label.toLowerCase()} found</td></tr>`;
        }

        this.selectedIndex = -1;
        this._updateFileActionButtons();
    }

    // Enable/disable the per-file action buttons based on the selection.
    // Delete works on any selection; Load only on loadable (primary-type)
    // entries — so when a dimmed non-primary file is selected in show-all
    // mode, the user can delete it but Load stays grayed out.
    _updateFileActionButtons() {
        if (!this.popup) return;
        const entry = this.directoryEntries[this.selectedIndex];
        const loadBtn = this.popup.querySelector('.gm-disk-load');
        const deleteBtn = this.popup.querySelector('.gm-disk-delete');
        if (loadBtn) loadBtn.disabled = !entry || !entry.loadable;
        if (deleteBtn) deleteBtn.disabled = !entry;
    }

    // Load the currently selected file (called from double-click, Enter,
    // or the Load button). Only loadable entries actually load.
    _loadSelected() {
        const entry = this.directoryEntries[this.selectedIndex];
        if (!entry || !entry.loadable) return;
        const data = this.loadFile(entry.fileName);
        if (this.popupOptions.onSelect) {
            this.popupOptions.onSelect(entry.fileName, data);
            this.closePopup();
            window.gmc64Telemetry && window.gmc64Telemetry.logEvent('file_loaded');
        }
    }

    // Delete prompt for the currently selected file. yes performs the
    // delete, no/outside-click cancels (the cancellation is handled by
    // _openPrompt's outside-mousedown dismissal).
    _promptDelete() {
        if (this.selectedIndex < 0 || this.selectedIndex >= this.directoryEntries.length) return;
        const prompt = this.popup.querySelector('.gm-disk-delete-prompt');
        const yes = prompt.querySelector('.gm-disk-delete-yes');
        const no = prompt.querySelector('.gm-disk-delete-no');
        const restore = this._openPrompt({ promptEl: prompt });
        yes.onclick = () => { restore(); this._performDelete(); };
        no.onclick  = () => restore();
    }

    _performDelete() {
        if (this.selectedIndex < 0 || this.selectedIndex >= this.directoryEntries.length) return;
        const entry = this.directoryEntries[this.selectedIndex];
        try {
            this.disk.deleteFile(entry.fileName);
            this.save();  // persist to localStorage
        } catch (e) {
            console.error('GMDisk: delete failed:', e.message);
            this.showInfoMessage('Delete failed');
            return;
        }
        this._updatePopupDirectory();
    }

    _onKeyDown(e) {
        if (!this.popup) return;

        // If a form field inside the popup is focused, let the event
        // flow naturally to the input — the field's own onkeydown
        // (Enter/Escape → confirm/cancel) and native browser handling
        // (arrow-key cursor movement) own the keys. We intentionally
        // do NOT stopPropagation in this branch: a capture-phase stop
        // at window would prevent the event from ever reaching the
        // input (capture descends from window → input). The editor's
        // own keydown handlers already skip when target is an input,
        // so there's no leak risk for this branch.
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // Non-input target: block editor / page-level keydown handlers
        // from seeing keys while popup is open. Done before any other
        // logic so the early-returns below still block the leak.
        e.stopImmediatePropagation();

        // Don't handle if a program is running
        if (window.vm && window.vm.running) return;

        switch (e.key) {
            case 'ArrowUp':
            case 'ArrowLeft':
                e.preventDefault();
                if (this.selectedIndex > 0) {
                    this._highlightFile(this.selectedIndex - 1);
                } else if (this.selectedIndex === -1 && this.directoryEntries.length > 0) {
                    this._highlightFile(this.directoryEntries.length - 1);
                }
                break;

            case 'ArrowDown':
            case 'ArrowRight':
                e.preventDefault();
                if (this.selectedIndex < this.directoryEntries.length - 1) {
                    this._highlightFile(this.selectedIndex + 1);
                }
                break;

            case 'Enter':
                e.preventDefault();
                this._loadSelected();
                break;

            case 'Escape':
                e.preventDefault();
                // Escape dismisses the active prompt if there is one;
                // closing the whole popup takes another Escape.
                if (this._activePrompt) this._activePrompt.restore();
                else this.closePopup();
                break;
        }
    }

    _highlightFile(index) {
        if (index < 0 || index >= this.directoryEntries.length) return;

        const rows = this.popup.querySelectorAll('.gm-disk-files tr[data-index]');
        rows.forEach((row, i) => {
            row.classList.toggle('selected', i === index);
        });
        this.selectedIndex = index;

        if (rows[index]) {
            rows[index].scrollIntoView({ block: 'nearest' });
        }

        // Prefill the save filename input with the selected file's base name —
        // matches the common file-dialog convention (selecting a file makes it
        // the default save target). Only when the save row exists.
        const input = this.popup.querySelector('.gm-disk-name-input');
        if (input) {
            input.value = this._baseNameForInput(this.directoryEntries[index].fileName);
        }

        this._updateFileActionButtons();
    }
}

// =========================================================================
// HELPER: Display name conversion
// =========================================================================

/**
 * Convert disk filename to display name
 * "PLAYER/SPR" -> "player"
 */
GMDisk.toDisplayName = function(diskName) {
    const slashIndex = diskName.lastIndexOf('/');
    const baseName = slashIndex >= 0 ? diskName.substring(0, slashIndex) : diskName;
    return baseName.toLowerCase().trim();
};

/**
 * Convert display name to disk filename
 * "player" + SPRITE -> "PLAYER/SPR"
 */
GMDisk.toDiskName = function(displayName, fileType) {
    return displayName.toUpperCase().trim() + fileType.extension;
};
