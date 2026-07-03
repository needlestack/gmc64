// Shared disk-picker overlay used by play.html and every editor. Two states:
//   - drop-zone: "Drop a .d64 here" GameMaker-button, with a hidden file
//                input for click-to-choose fallback
//   - program-picker: list of files on the loaded disk, filtered to the
//                host's extension (PRG / SPR / PIC / SND / SNG)
//
// Callers mount once at page init, then either:
//   - call showProgramPicker() when they already have a disk (URL-driven
//     load with ?disk= but no ?file=)
//   - enable windowDropEnabled to auto-show the drop-zone on drag-and-
//     drop of a .d64 anywhere in the window
//
// Post-pick, callers get the file name + bytes + parsed D64 via
// onPickFile(name, bytes, disk, diskLabel). What they do with it varies
// by host (editor loads into the program listing, sprite-maker into the
// sprite canvas, play.html into the poster + play flow, etc.).
//
// Styling: GameMaker quit-menu aesthetic (dark gray screen, gray3-blue
// raised buttons). CSS injects once per page on first mount and lives
// under `.gmdp-*` class prefixes so it can't collide with host styles.

globalThis.GMDiskPicker = (function () {

    // The `--gameborder-h, 100vh` fallback lets the same rule work in
    // play.html (where --gameborder-h is defined and reflects the game
    // border's real height) AND in editors where the overlay covers the
    // viewport (no --gameborder-h; fall back to raw viewport height).
    const CSS = `
@font-face {
    font-family: C64;
    src: url(css/fonts/C64_Pro_Mono_Narrow8.woff2);
}

.gmdp-overlay {
    display: none;
    position: absolute;
    inset: 0;
    padding: max(0px, min(48px, calc((var(--gameborder-h, 100vh) - 400px) / 2)));
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    background: rgb(0, 0, 0);
}
.gmdp-overlay.active { display: flex; }

.gmdp-content {
    height: 100%;
    aspect-ratio: 6 / 5;
    min-height: 400px;
    box-sizing: border-box;
    background: rgb(98, 98, 98);         /* c64-gray1 */
    font-family: C64, monospace;
    padding: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: rgb(205, 205, 205);
}

.gmdp-content code { font-family: inherit; font-size: inherit; }

.gmdp-content > * {
    width: 100%;
    max-width: 380px;
    text-align: center;
}

.gmdp-heading {
    font-size: 12px;
    margin: 0 0 14px 0;
    font-weight: normal;
    color: rgb(205, 205, 205);
}
.gmdp-disk-name {
    font-size: 11px;
    margin: 0 0 12px 0;
    color: rgb(205, 205, 205);
}

/* GameMaker raised button: gray3 fill, blue text, black 3D bevel via
   thicker bottom/right borders. Same as css/gm-ui.css's global button. */
.gmdp-drop-target {
    display: block;
    background: rgb(205, 205, 205);      /* c64-gray3 */
    color: rgb(25, 73, 180);             /* c64-blue */
    border: 3px solid black;
    border-bottom: 6px solid black;
    border-right: 6px solid black;
    padding: 16px 24px;
    cursor: pointer;
    transition: background 0.1s;
}
.gmdp-drop-target:hover,
.gmdp-drop-target.gmdp-drag-over {
    background: rgb(255, 255, 255);      /* c64-white */
}
.gmdp-drop-hint {
    font-size: 13px;
    margin-bottom: 6px;
}
.gmdp-drop-sub {
    font-size: 11px;
    opacity: 0.75;
}
.gmdp-drop-input { display: none; }

/* Program list — same raised-panel bevel, quit-menu-style link rows.
   max-height caps the panel so it always fits inside the 400px-min
   mini-screen (with room for the heading + disk-name above); long
   file lists scroll internally rather than pushing the panel out of
   the mini-screen and getting clipped. */
.gmdp-list {
    list-style: none;
    margin: 0;
    padding: 12px 20px;
    max-height: 220px;
    overflow-y: auto;
    background: rgb(205, 205, 205);
    border: 3px solid black;
    border-bottom: 6px solid black;
    border-right: 6px solid black;
    text-align: left;
    box-sizing: border-box;
}
.gmdp-list li {
    padding: 3px 8px;
    cursor: pointer;
    font-size: 12px;
    color: rgb(25, 73, 180);
    transition: color 0.1s;
}
.gmdp-list li:hover {
    color: rgb(169, 71, 100);            /* c64-red */
}

.gmdp-error {
    display: none;
    font-size: 11px;
    margin-top: 12px;
    color: rgb(169, 71, 100);
}
`;

    let cssInjected = false;
    function injectCSS() {
        if (cssInjected) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        cssInjected = true;
    }

    // Detect that a drag actually carries files (not, e.g., text or an
    // in-page HTML5 drag from a list). Some browsers redact file metadata
    // during drag for security, so this is a "yes, files are involved"
    // check rather than a `.d64`-specific one — the extension is checked
    // only on drop where we can read `file.name`.
    function dragCarriesFile(dt) {
        if (!dt) return false;
        const types = dt.types;
        // types is a DOMStringList; iterate with a loop that works both
        // for old and new browsers.
        for (let i = 0; i < types.length; i++) {
            if (types[i] === 'Files') return true;
        }
        return false;
    }

    function mount(hostEl, options) {
        const { extension, onPickFile, windowDropEnabled, disk } = options;
        // Optional: when a drop yields 2+ matches, call this instead of
        // showing the module's own overlay picker. Editors use it to
        // hand off to their existing file-popup UI (which already has
        // previews for sprites/scenes, etc.) so users only ever see one
        // picker. If not provided, the module's overlay picker is used.
        const customPicker = options.showPicker;
        injectCSS();

        const overlay = document.createElement('div');
        overlay.className = 'gmdp-overlay';
        overlay.innerHTML = `
            <div class="gmdp-content">
                <div class="gmdp-drop-section">
                    <label class="gmdp-drop-target">
                        <div class="gmdp-drop-hint">Drop a <code>.d64</code> here</div>
                        <div class="gmdp-drop-sub">or click to choose a file</div>
                        <input type="file" class="gmdp-drop-input" accept=".d64">
                    </label>
                    <div class="gmdp-error"></div>
                </div>
                <div class="gmdp-pick-section" style="display: none;">
                    <h2 class="gmdp-heading">Choose a program</h2>
                    <p class="gmdp-disk-name"></p>
                    <ul class="gmdp-list"></ul>
                </div>
            </div>
        `;
        hostEl.appendChild(overlay);

        const dropTarget  = overlay.querySelector('.gmdp-drop-target');
        const dropInput   = overlay.querySelector('.gmdp-drop-input');
        const dropSection = overlay.querySelector('.gmdp-drop-section');
        const pickSection = overlay.querySelector('.gmdp-pick-section');
        const errBox      = overlay.querySelector('.gmdp-error');
        const diskLabelEl = overlay.querySelector('.gmdp-disk-name');
        const listEl      = overlay.querySelector('.gmdp-list');

        function isVisible() { return overlay.classList.contains('active'); }
        function hide() { overlay.classList.remove('active'); }

        function showDropZone() {
            errBox.style.display = 'none';
            dropSection.style.display = '';
            pickSection.style.display = 'none';
            overlay.classList.add('active');
        }

        function showProgramPicker(disk, files, diskLabel) {
            diskLabelEl.textContent = diskLabel || '';
            listEl.innerHTML = '';
            for (const name of files) {
                const li = document.createElement('li');
                li.textContent = name;
                li.addEventListener('click', () => {
                    const bytes = disk.readFile(name);
                    if (!bytes) return;
                    hide();
                    onPickFile(name, bytes, disk, diskLabel);
                });
                listEl.appendChild(li);
            }
            dropSection.style.display = 'none';
            pickSection.style.display = '';
            overlay.classList.add('active');
        }

        function showError(msg) {
            errBox.textContent = msg;
            errBox.style.display = '';
            dropSection.style.display = '';
            pickSection.style.display = 'none';
            overlay.classList.add('active');
        }

        // Parse a File as a .d64, then run the same auto-load/pick logic
        // as the URL flow: 0 matches → error; 1 match → auto-pick;
        // multiple → show the program picker.
        //
        // If a GMDisk was passed to mount(), the dropped bytes get
        // promoted into the shared localStorage pool AND selected as the
        // current disk — so subsequent "file" button clicks see the
        // just-dropped disk, saves land in the right place, and other
        // editors see it too. addToPool dedupes by SHA-256 so re-dropping
        // the same disk is a no-op that just re-selects the existing
        // pool entry.
        async function handleFile(file) {
            errBox.style.display = 'none';
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const parsed = new D64(bytes);
                if (disk) {
                    try {
                        const id = await GMDisk.addToPool(bytes, file.name);
                        disk.selectDisk(id);
                    } catch (e) {
                        // Pool insert can fail (quota, private mode). Fall
                        // through with the in-memory disk — the current
                        // pick still works, just doesn't persist.
                        console.warn('GMDiskPicker: pool insert failed:', e.message);
                    }
                }
                // The host's `disk` object now points at the pool entry
                // (via selectDisk); fall back to the in-memory `parsed`
                // when no host disk was provided.
                const activeD64 = disk?.disk || parsed;
                // gmParser needs loadFileByName to resolve multi-part
                // sprite references etc. Point it at this disk.
                globalThis.loadFileByName = (name) => {
                    try { return activeD64.readFile(name); } catch (e) { return null; }
                };
                const matches = GMTools.listFilesByExtension(activeD64, extension);
                if (matches.length === 0) {
                    showError(`no ${extension.toLowerCase()} files on disk`);
                    return;
                }
                if (matches.length === 1) {
                    const name = matches[0];
                    const data = activeD64.readFile(name);
                    hide();
                    onPickFile(name, data, activeD64, file.name);
                    return;
                }
                // 2+ matches: hand off to the caller's custom picker if
                // one was provided (editors use their existing file-popup
                // UI); otherwise fall back to the module's overlay picker.
                if (customPicker) {
                    hide();
                    customPicker(matches, file.name);
                } else {
                    showProgramPicker(activeD64, matches, file.name);
                }
            } catch (e) {
                showError("that doesn't look like a valid .d64");
            }
        }

        // Drop handlers on the drop-target label — used when the user
        // drops directly onto the visible button.
        dropInput.addEventListener('change', () => {
            if (dropInput.files && dropInput.files[0]) handleFile(dropInput.files[0]);
        });
        dropTarget.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropTarget.classList.add('gmdp-drag-over');
        });
        dropTarget.addEventListener('dragleave', () => {
            dropTarget.classList.remove('gmdp-drag-over');
        });
        dropTarget.addEventListener('drop', (e) => {
            e.preventDefault();
            dropTarget.classList.remove('gmdp-drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file) handleFile(file);
        });

        // Window-level drop: any file dragged into the window shows the
        // overlay. If the overlay was already visible when the drag
        // started (e.g., URL missing ?file=), leave it visible on
        // dragleave — otherwise auto-hide when the drag exits the window.
        // Counter-based nesting handles dragenter/leave fluctuations as
        // the cursor crosses inner elements.
        if (windowDropEnabled) {
            let dragCounter = 0;
            let wasVisibleBeforeDrag = false;

            window.addEventListener('dragenter', (e) => {
                if (!dragCarriesFile(e.dataTransfer)) return;
                if (dragCounter === 0) {
                    wasVisibleBeforeDrag = isVisible();
                    showDropZone();
                }
                dragCounter++;
                e.preventDefault();
            });
            window.addEventListener('dragleave', (e) => {
                if (!dragCarriesFile(e.dataTransfer)) return;
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    if (!wasVisibleBeforeDrag) hide();
                }
            });
            window.addEventListener('dragover', (e) => {
                // Preventing default here is what lets `drop` fire.
                if (dragCarriesFile(e.dataTransfer)) e.preventDefault();
            });
            window.addEventListener('drop', (e) => {
                dragCounter = 0;
                if (!dragCarriesFile(e.dataTransfer)) return;
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) handleFile(file);
                else if (!wasVisibleBeforeDrag) hide();
            });
        }

        return { showDropZone, showProgramPicker, showError, hide, isVisible };
    }

    return { mount };
})();
