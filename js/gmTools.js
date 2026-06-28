/**
 * gmTools.js — GMC64 shared utilities
 *
 * Small utilities shared across the GMC64 editor pages.
 *
 * Used by: sprite-maker.html, scene-maker.html
 * Requires: c64lib.js (for c64Palette, c64ColorNames)
 * CSS: css/c64-ui.css (defines .color-picker-overlay, .color-picker-dialog, etc.)
 */

const GMTools = {

    // =========================================================================
    // COLOR PICKER
    // =========================================================================
    // Shows a 16-color C64 palette picker popup positioned near the click point.
    // Creates DOM elements dynamically on first use; reuses them thereafter.
    // Layout (2 columns, 8 rows) is controlled by CSS in c64-ui.css.
    //
    // Usage:
    //   GMTools.colorPicker.show({
    //       x: event.clientX,
    //       y: event.clientY,
    //       onSelect: (colorIndex) => { ... }  // colorIndex is 0-15
    //   });

    colorPicker: {
        _overlay: null,
        _dialog: null,
        _onSelect: null,
        _onClose: null,

        /**
         * Show the color picker
         * @param {Object} options
         * @param {number} options.x - Click X position (dialog will center horizontally on this)
         * @param {number} options.y - Click Y position (dialog will appear 10px below this)
         * @param {Function} options.onSelect - Callback(colorIndex) when color is picked
         * @param {Function} options.onClose - Optional callback when picker is closed without selection
         */
        show(options) {
            this._onSelect = options.onSelect || null;
            this._onClose = options.onClose || null;

            // Create overlay if needed
            if (!this._overlay) {
                this._createElements();
            }

            // Show overlay
            this._overlay.style.display = 'block';

            // Position dialog: top-center at click, 10px down
            const dialog = this._dialog;
            dialog.style.left = options.x + 'px';
            dialog.style.top = (options.y + 10) + 'px';
            dialog.style.transform = 'translateX(-50%)';

            // Adjust if off-screen (check after positioning)
            requestAnimationFrame(() => {
                const rect = dialog.getBoundingClientRect();

                // Too far right?
                if (rect.right > window.innerWidth) {
                    dialog.style.left = (window.innerWidth - rect.width / 2 - 10) + 'px';
                }
                // Too far left?
                if (rect.left < 0) {
                    dialog.style.left = (rect.width / 2 + 10) + 'px';
                }
                // Too far down?
                if (rect.bottom > window.innerHeight) {
                    // Position above the click instead
                    dialog.style.top = (options.y - rect.height - 10) + 'px';
                }
            });
        },

        /**
         * Hide the color picker
         */
        hide() {
            if (this._overlay) {
                this._overlay.style.display = 'none';
            }
            this._onSelect = null;
            this._onClose = null;
        },

        /**
         * Check if picker is currently open
         */
        isOpen() {
            return this._overlay && this._overlay.style.display === 'block';
        },

        /**
         * Create the overlay and dialog elements
         */
        _createElements() {
            // Create overlay
            this._overlay = document.createElement('div');
            this._overlay.className = 'color-picker-overlay';
            this._overlay.onclick = (e) => {
                if (e.target === this._overlay) {
                    if (this._onClose) this._onClose();
                    this.hide();
                }
            };

            // Create dialog
            this._dialog = document.createElement('div');
            this._dialog.className = 'color-picker-dialog';

            // Create grid
            const grid = document.createElement('div');
            grid.className = 'color-picker-grid';

            // Add color swatches (0-15)
            for (let i = 0; i < 16; i++) {
                const swatch = document.createElement('div');
                swatch.className = 'color-swatch';
                swatch.style.background = this._paletteToCSS(i);
                swatch.textContent = c64ColorNames[i];

                // Light text on dark colors (black, red, blue, brown, dark gray)
                if ([0, 2, 6, 9, 11].includes(i)) {
                    swatch.style.color = `rgb(${c64Palette.white[0]}, ${c64Palette.white[1]}, ${c64Palette.white[2]})`;
                }

                swatch.onclick = () => {
                    if (this._onSelect) {
                        this._onSelect(i);
                    }
                    this.hide();
                };

                grid.appendChild(swatch);
            }

            this._dialog.appendChild(grid);
            this._overlay.appendChild(this._dialog);
            document.body.appendChild(this._overlay);
        },

        /**
         * Convert C64 palette index to CSS color string
         */
        _paletteToCSS(colorIndex) {
            const rgba = c64Palette[colorIndex];
            if (!rgba) return `rgb(${c64Palette.black[0]}, ${c64Palette.black[1]}, ${c64Palette.black[2]})`;
            return `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
        }
    },

    // =========================================================================
    // FILENAME FORMATTING
    // =========================================================================

    /**
     * Format a GMC64 filename: 6 chars (space-padded) + /EXT
     *
     * Whitespace is preserved as-is — names can contain significant
     * spaces (e.g. "JET R /SPR", "STARS /PIC"). We don't trim and we
     * don't strip middle spaces; we only filter out characters the GMC64
     * character set doesn't have.
     *
     * @param {string} baseName - The base name (will be uppercased, truncated to 6 chars)
     * @param {string} extension - The extension without slash (e.g., 'SPR', 'PIC', 'SND')
     * @returns {string} Formatted filename like "PLAYER/SPR" or "AB CD /SPR"
     */
    formatFileName(baseName, extension) {
        const cleanName = baseName.toUpperCase().replace(/[^A-Z0-9 ]/g, '').substring(0, 6);
        const paddedName = cleanName.padEnd(6, ' ');
        return paddedName + '/' + extension;
    },

    // =========================================================================
    // DRAGGABLE FIELD
    // =========================================================================
    // Makes an element draggable to change its value (numeric or enumerated).
    // Supports three interaction modes:
    // - Drag up/down to change value
    // - Click (not drag) to open dropdown with all options
    // - Type to search/filter options in dropdown
    //
    // Features:
    // - Numeric values with min/max bounds
    // - Enumerated values (array of options)
    // - Configurable sensitivity for drag
    // - 5-pixel threshold before drag starts (allows clicks)
    // - Keyboard navigation (arrows, enter, escape, typing)
    //
    // Usage:
    //   GMTools.draggableField.attach(element, {
    //       type: 'numeric',           // or 'enum'
    //       min: 0, max: 31,           // for numeric
    //       values: ['a', 'b', 'c'],   // for enum
    //       getValue: () => currentValue,
    //       setValue: (v) => { currentValue = v; },
    //       sensitivity: 0.2,          // optional, pixels per unit (default auto)
    //       onChange: (v) => { ... },  // optional callback after value changes
    //       formatValue: (v) => '...',  // optional display formatter for dropdown
    //       liveUpdate: false,         // optional, if true setValue called on arrow key nav
    //       closeOnSelect: true        // optional, if false dropdown stays open on click
    //   });

    draggableField: {
        _active: null,  // Current drag state
        _dropdown: {
            overlay: null,
            dialog: null,
            element: null,
            options: null,
            allValues: [],
            filteredValues: [],
            selectedIndex: 0,
            searchText: '',
            keyHandler: null
        },

        /**
         * Attach draggable behavior to an element
         */
        attach(element, options) {
            const DRAG_THRESHOLD = 5;

            // Idempotent: if already attached, just refresh the options and bail.
            // Use the _draggableOptions marker as the source of truth — the data-draggable
            // attribute can be stripped externally, which would otherwise cause a
            // second attach to stack duplicate listeners.
            if (element._draggableOptions) {
                element._draggableOptions = options;
                element.dataset.draggable = 'true'; // restore in case it was cleared
                return;
            }
            element._draggableOptions = options;

            // All listeners below read options from element._draggableOptions, so the
            // options passed to attach() can be replaced on subsequent calls.
            const opts = () => element._draggableOptions;

            element.style.cursor = 'ns-resize';
            element.dataset.draggable = 'true';
            if (!element.hasAttribute('tabindex')) {
                element.tabIndex = 0;
            }

            // Track focus so .is-interacting persists for arrow-key use
            element.addEventListener('focus', () => {
                element.classList.add('is-interacting');
            });
            element.addEventListener('blur', () => {
                // Don't drop interacting state while our dropdown is open for this element
                if (this.isDropdownOpen() && this._dropdown.element === element) return;
                element.classList.remove('is-interacting');
            });

            // Arrow-key increment/decrement when focused (dropdown closed)
            element.addEventListener('keydown', (e) => {
                if (this.isDropdownOpen()) return; // dropdown's own handler takes over
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

                e.preventDefault();
                e.stopImmediatePropagation();

                const options = opts();
                const cur = options.getValue();
                let next;
                if (options.type === 'enum') {
                    const idx = options.values.indexOf(cur);
                    const step = e.key === 'ArrowUp' ? -1 : 1;
                    const newIdx = Math.max(0, Math.min(options.values.length - 1, idx + step));
                    next = options.values[newIdx];
                } else {
                    const step = e.key === 'ArrowUp' ? 1 : -1;
                    const lo = options.min !== undefined ? options.min : 0;
                    const hi = options.max !== undefined ? options.max : 100;
                    next = Math.max(lo, Math.min(hi, cur + step));
                }

                if (next !== cur) {
                    options.setValue(next);
                    if (options.onChange) options.onChange(next);
                }
            });

            element.addEventListener('mousedown', (e) => {
                e.preventDefault();

                // Mark this element as the active interaction target and lock out other draggables
                element.focus();
                element.classList.add('is-interacting');
                document.body.classList.add('draggable-dragging');

                const options = opts();
                const startY = e.clientY;
                const startX = e.clientX;
                const startValue = options.getValue();

                // Calculate sensitivity based on range
                let sensitivity = options.sensitivity;
                if (sensitivity === undefined) {
                    if (options.type === 'enum') {
                        // For enums: larger lists need lower sensitivity
                        const count = options.values.length;
                        sensitivity = count > 20 ? 0.1 : (count > 10 ? 0.15 : 0.25);
                    } else {
                        // For numeric: scale based on range
                        const range = (options.max || 100) - (options.min || 0);
                        sensitivity = range > 100 ? 1.0 : (range > 20 ? 0.5 : 0.2);
                    }
                }

                let dragStarted = false;
                let lastValue = startValue;

                const onMove = (moveEvent) => {
                    const deltaY = startY - moveEvent.clientY;

                    // Check threshold
                    if (!dragStarted && Math.abs(deltaY) < DRAG_THRESHOLD) {
                        return;
                    }
                    dragStarted = true;

                    let newValue;
                    if (options.type === 'enum') {
                        // For enum: delta moves through list
                        // Drag up = earlier items (lower index), drag down = later items (higher index)
                        const startIndex = options.values.indexOf(startValue);
                        const indexDelta = Math.round(-deltaY * sensitivity); // Negate for natural direction
                        let newIndex = startIndex + indexDelta;
                        newIndex = Math.max(0, Math.min(options.values.length - 1, newIndex));
                        newValue = options.values[newIndex];
                    } else {
                        // For numeric: delta changes value
                        newValue = startValue + Math.round(deltaY * sensitivity);
                        newValue = Math.max(options.min || 0, Math.min(options.max || 100, newValue));
                    }

                    if (newValue !== lastValue) {
                        lastValue = newValue;
                        options.setValue(newValue);
                        if (options.onChange) {
                            options.onChange(newValue);
                        }
                    }
                };

                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.classList.remove('draggable-dragging');
                    this._active = null;

                    // If no drag happened, it was a click - toggle dropdown
                    if (!dragStarted) {
                        // If dropdown is already open for this element, close it
                        if (this.isDropdownOpen() && this._dropdown.element === element) {
                            this._hideDropdown();
                        } else {
                            this._showDropdown(element, options, startX, startY);
                        }
                    }
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                this._active = { element, options };
            });
        },

        /**
         * Check if a drag is currently active
         */
        isActive() {
            return this._active !== null;
        },

        /**
         * Check if dropdown is open
         */
        isDropdownOpen() {
            return this._dropdown.overlay && this._dropdown.overlay.style.display === 'block';
        },

        /**
         * Show the dropdown picker
         */
        _showDropdown(element, options, x, y) {
            const dd = this._dropdown;
            dd.element = element;
            dd.options = options;
            dd.searchText = '';

            // Build list of values
            if (options.type === 'enum') {
                dd.allValues = options.values.slice();
            } else {
                // Numeric: create array of values
                dd.allValues = [];
                for (let v = options.min || 0; v <= (options.max || 100); v++) {
                    dd.allValues.push(v);
                }
            }

            dd.filteredValues = dd.allValues.slice();

            // Find current value's index
            const currentValue = options.getValue();
            dd.selectedIndex = dd.filteredValues.indexOf(currentValue);
            if (dd.selectedIndex < 0) dd.selectedIndex = 0;

            // Create overlay if needed
            if (!dd.overlay) {
                this._createDropdownElements();
            }

            // Add keyboard handler
            this._addKeyHandler();

            // Show and position. Width matches the host element so dropdown
            // entries can use its full width for structured layouts.
            dd.overlay.style.display = 'block';
            const rect = element.getBoundingClientRect();
            dd.dialog.style.left = rect.left + 'px';
            dd.dialog.style.top = (rect.bottom + 2) + 'px';
            dd.dialog.style.width = rect.width + 'px';

            this._renderDropdown();

            // Center the currently-selected item in the visible area on initial open.
            // (Subsequent renders during arrow-key nav use 'nearest' to avoid jumping.)
            const selectedEl = dd.dialog.querySelector('.draggable-dropdown-item.selected');
            if (selectedEl) {
                dd.dialog.scrollTop = selectedEl.offsetTop
                    - (dd.dialog.clientHeight - selectedEl.clientHeight) / 2;
            }

            // Adjust if off-screen
            requestAnimationFrame(() => {
                const dialogRect = dd.dialog.getBoundingClientRect();
                if (dialogRect.right > window.innerWidth) {
                    dd.dialog.style.left = (window.innerWidth - dialogRect.width - 10) + 'px';
                }
                if (dialogRect.bottom > window.innerHeight) {
                    dd.dialog.style.top = (rect.top - dialogRect.height - 2) + 'px';
                }
            });
        },

        /**
         * Hide the dropdown
         */
        _hideDropdown() {
            const dd = this._dropdown;
            if (dd.overlay) {
                dd.overlay.style.display = 'none';
            }
            if (dd.keyHandler) {
                document.removeEventListener('keydown', dd.keyHandler, true);
                dd.keyHandler = null;
            }
            // Restore focus to the field so arrow keys keep working after close
            if (dd.element) {
                dd.element.focus();
            }
            dd.element = null;
            dd.options = null;
        },

        /**
         * Create dropdown DOM elements
         */
        _createDropdownElements() {
            const dd = this._dropdown;

            dd.overlay = document.createElement('div');
            dd.overlay.className = 'draggable-dropdown-overlay';
            dd.overlay.onclick = (e) => {
                if (e.target === dd.overlay) {
                    this._hideDropdown();
                }
            };

            dd.dialog = document.createElement('div');
            dd.dialog.className = 'draggable-dropdown';

            dd.overlay.appendChild(dd.dialog);
            document.body.appendChild(dd.overlay);
        },

        /**
         * Add keyboard handler for dropdown navigation
         */
        _addKeyHandler() {
            const dd = this._dropdown;
            if (dd.keyHandler) return; // Already attached

            dd.keyHandler = (e) => {
                if (!this.isDropdownOpen()) return;

                // Use stopImmediatePropagation to prevent other document-level handlers from seeing these keys
                switch (e.key) {
                    case 'ArrowUp':
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        if (dd.selectedIndex > 0) {
                            dd.selectedIndex--;
                            this._renderDropdown();
                            // If liveUpdate, apply value immediately
                            if (dd.options.liveUpdate) {
                                this._applySelectedValue();
                            }
                        }
                        break;
                    case 'ArrowDown':
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        if (dd.selectedIndex < dd.filteredValues.length - 1) {
                            dd.selectedIndex++;
                            this._renderDropdown();
                            // If liveUpdate, apply value immediately
                            if (dd.options.liveUpdate) {
                                this._applySelectedValue();
                            }
                        }
                        break;
                    case 'Enter':
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        this._selectDropdownItem(dd.selectedIndex, true); // true = close dropdown
                        break;
                    case 'Escape':
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        this._hideDropdown();
                        break;
                    case 'Backspace':
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        if (dd.searchText.length > 0) {
                            dd.searchText = dd.searchText.slice(0, -1);
                            this._filterDropdown();
                        }
                        break;
                    default:
                        // Typing - add to search if printable
                        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                            e.preventDefault();
                            e.stopImmediatePropagation();
                            dd.searchText += e.key;
                            this._filterDropdown();
                        }
                        break;
                }
            };
            document.addEventListener('keydown', dd.keyHandler, true); // Capture phase to run before other handlers
        },

        /**
         * Filter dropdown values based on search text
         */
        _filterDropdown() {
            const dd = this._dropdown;
            const search = dd.searchText.toLowerCase();

            if (!search) {
                dd.filteredValues = dd.allValues.slice();
            } else {
                dd.filteredValues = dd.allValues.filter(v => {
                    const display = this._formatDropdownValue(v, dd.options);
                    return display.toLowerCase().startsWith(search);
                });
            }

            dd.selectedIndex = 0;
            this._renderDropdown();
        },

        /**
         * Format a value for display
         */
        _formatDropdownValue(value, options) {
            if (options.formatValue) {
                return options.formatValue(value);
            }
            return String(value);
        },

        /**
         * Render the dropdown contents
         */
        _renderDropdown() {
            const dd = this._dropdown;
            dd.dialog.innerHTML = '';

            if (dd.filteredValues.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'draggable-dropdown-empty';
                empty.textContent = 'no match';
                dd.dialog.appendChild(empty);
                return;
            }

            dd.filteredValues.forEach((value, index) => {
                const item = document.createElement('div');
                item.className = 'draggable-dropdown-item' + (index === dd.selectedIndex ? ' selected' : '');

                // Custom rendering hook for structured items (e.g. multi-line).
                // formatValue is still used for typed-search matching.
                if (typeof dd.options.renderItem === 'function') {
                    const content = dd.options.renderItem(value);
                    if (content instanceof Node) {
                        item.appendChild(content);
                    } else {
                        item.innerHTML = String(content);
                    }
                } else {
                    const display = this._formatDropdownValue(value, dd.options);

                    // Highlight matching text if searching
                    if (dd.searchText) {
                        const matchLen = dd.searchText.length;
                        const displayLower = display.toLowerCase();
                        const searchLower = dd.searchText.toLowerCase();

                        if (displayLower.startsWith(searchLower)) {
                            const matchSpan = document.createElement('span');
                            matchSpan.className = 'match-highlight';
                            matchSpan.textContent = display.substring(0, matchLen);
                            item.appendChild(matchSpan);
                            item.appendChild(document.createTextNode(display.substring(matchLen)));
                        } else {
                            item.textContent = display;
                        }
                    } else {
                        item.textContent = display;
                    }
                }

                item.onclick = () => this._selectDropdownItem(index);
                dd.dialog.appendChild(item);
            });

            // Scroll selected into view
            const selected = dd.dialog.querySelector('.draggable-dropdown-item.selected');
            if (selected) {
                selected.scrollIntoView({ block: 'nearest' });
            }
        },

        /**
         * Apply the currently selected value without closing dropdown
         */
        _applySelectedValue() {
            const dd = this._dropdown;
            if (dd.selectedIndex < 0 || dd.selectedIndex >= dd.filteredValues.length) return;

            const value = dd.filteredValues[dd.selectedIndex];
            dd.options.setValue(value);
            if (dd.options.onChange) {
                dd.options.onChange(value);
            }
        },

        /**
         * Select an item from the dropdown
         * @param {number} index - Index in filteredValues
         * @param {boolean} forceClose - If true, always close. If false, respect closeOnSelect option.
         */
        _selectDropdownItem(index, forceClose = false) {
            const dd = this._dropdown;

            if (index < 0 || index >= dd.filteredValues.length) {
                this._hideDropdown();
                return;
            }

            const value = dd.filteredValues[index];
            dd.options.setValue(value);
            if (dd.options.onChange) {
                dd.options.onChange(value);
            }

            // Close dropdown unless closeOnSelect is explicitly false
            const shouldClose = forceClose || (dd.options.closeOnSelect !== false);
            if (shouldClose) {
                this._hideDropdown();
            } else {
                // Just update selection visually
                this._renderDropdown();
            }
        }
    },

    // =========================================================================
    // PREVIEW LOADER
    // =========================================================================
    // Browse files on a disk with live preview — the GameMaker-original loading
    // UX. Currently used for sprites; built so scene-maker (and any other visual
    // tool) can plug in by passing a renderer.
    //
    // Behaviour:
    // - Lists files of the given type on the disk; bails out with a flashing
    //   message if there are none.
    // - Saves the tool's current state on entry so a Cancel can restore it.
    // - Shows "load FILENAME? yes  no" in the message area. The filename is a
    //   GMTools.draggableField so users can drag/type/arrow-key through files.
    // - ArrowUp/Down cycle. Enter / 'y' / clicking 'yes' commits. Escape /
    //   'n' / clicking 'no' cancels.
    // - Every cycle calls onPreview(fileName, fileData) so the tool can update
    //   its display in place.
    //
    // Usage:
    //   GMTools.previewLoader.enter({
    //       disk,                          // GMDisk instance
    //       fileType,                      // GMDisk.FILE_TYPES.SPRITE | .SCENE
    //       messageArea,                   // DOM element for the prompt UI
    //       emptyMessage: 'no sprites on disk',
    //       saveState:  () => {...stateObj...},
    //       onPreview:  (fileName, fileData) => { ... draw ... },
    //       onConfirm:  (fileName, fileData) => { ... commit ... },
    //       onCancel:   (savedState) => { ... restore from saveState() ... },
    //       onExit:     () => { ... optional, fires after confirm or cancel ... }
    //   });

    previewLoader: {
        _active: false,
        _files: [],
        _currentIndex: 0,
        _savedState: null,
        _options: null,
        _keyHandler: null,

        isActive() {
            return this._active;
        },

        currentIndex() {
            return this._currentIndex;
        },

        files() {
            return this._files;
        },

        enter(options) {
            if (this._active) return false;

            const files = options.disk.listFiles(options.fileType);
            if (files.length === 0) {
                // No files of this type — flash a message, dismiss on any click.
                GMTools.flashingMessage.show(options.messageArea, options.emptyMessage || 'no files on disk');
                const dismiss = () => {
                    GMTools.flashingMessage.hide();
                    options.messageArea.innerHTML = '';
                    document.removeEventListener('click', dismiss, true);
                };
                document.addEventListener('click', dismiss, true);
                return false;
            }

            this._active = true;
            this._files = files;
            this._currentIndex = 0;
            this._options = options;
            this._savedState = options.saveState ? options.saveState() : null;

            this._keyHandler = (e) => this._onKey(e);
            document.addEventListener('keydown', this._keyHandler);

            this._preview(0);
            return true;
        },

        exit() {
            if (!this._active) return;
            this._active = false;

            if (this._keyHandler) {
                document.removeEventListener('keydown', this._keyHandler);
                this._keyHandler = null;
            }
            GMTools.flashingMessage.hide();
            if (this._options && this._options.messageArea) {
                this._options.messageArea.innerHTML = '';
            }

            const opts = this._options;
            this._options = null;
            this._files = [];
            this._currentIndex = 0;
            this._savedState = null;

            if (opts && opts.onExit) opts.onExit();
        },

        confirm() {
            if (!this._active) return;
            const entry = this._files[this._currentIndex];
            const opts = this._options;
            const data = opts.disk.loadFile(entry.fileName);
            if (opts.onConfirm) opts.onConfirm(entry.fileName, data);
            this.exit();
        },

        cancel() {
            if (!this._active) return;
            const opts = this._options;
            const saved = this._savedState;
            if (opts.onCancel) opts.onCancel(saved);
            this.exit();
        },

        /**
         * Jump to a specific file by index. Called by the draggable filename
         * field and by internal arrow-key handling.
         */
        previewAtIndex(index) {
            if (!this._active) return;
            if (index < 0 || index >= this._files.length) return;
            if (index === this._currentIndex) return;
            this._preview(index);
        },

        _preview(index) {
            this._currentIndex = index;
            const entry = this._files[index];
            const data = this._options.disk.loadFile(entry.fileName);
            if (!data) return;
            try {
                this._options.onPreview(entry.fileName, data);
            } catch (e) {
                console.error('previewLoader: onPreview threw:', e);
            }
            this._renderMessage();
        },

        _renderMessage() {
            const opts = this._options;
            const entry = this._files[this._currentIndex];
            const ext = (opts.fileType && opts.fileType.extension) || '';
            // Strip extension and lowercase; trailing space from 6-char padding kept as-is.
            const display = (ext ? entry.fileName.replace(new RegExp(ext.replace('/', '\\/') + '$', 'i'), '') : entry.fileName).toLowerCase();

            const area = opts.messageArea;
            area.innerHTML =
                '<span style="color: var(--c64-yellow)">load </span>' +
                '<span class="load-filename" style="color: var(--c64-white); background: var(--c64-blue); padding: 0 4px">' + display + '</span>' +
                '<span style="color: var(--c64-yellow)">?</span><br>' +
                '<span class="load-yes gm-yes-no">yes</span>' +
                '<span style="display: inline-block; width: 80px"></span>' +
                '<span class="load-no gm-yes-no">no</span>';

            area.querySelector('.load-yes').addEventListener('click', () => this.confirm());
            area.querySelector('.load-no').addEventListener('click', () => this.cancel());

            // Filename is draggable so users can scrub/click-pick/type-search through files
            const filenameSpan = area.querySelector('.load-filename');
            GMTools.draggableField.attach(filenameSpan, {
                type: 'enum',
                values: this._files.map(f => f.fileName),
                getValue: () => this._files[this._currentIndex].fileName,
                setValue: (fileName) => {
                    const newIndex = this._files.findIndex(f => f.fileName === fileName);
                    if (newIndex >= 0 && newIndex !== this._currentIndex) {
                        this._preview(newIndex);
                    }
                },
                formatValue: (fileName) => {
                    const slashIndex = fileName.indexOf('/');
                    return (slashIndex > 0 ? fileName.substring(0, slashIndex) : fileName).toLowerCase().trim();
                },
                liveUpdate: true,
                closeOnSelect: false
            });
        },

        _onKey(e) {
            if (!this._active) return;
            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    if (this._currentIndex > 0) this._preview(this._currentIndex - 1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (this._currentIndex < this._files.length - 1) this._preview(this._currentIndex + 1);
                    break;
                case 'Enter':
                case 'y':
                case 'Y':
                    e.preventDefault();
                    this.confirm();
                    break;
                case 'Escape':
                case 'n':
                case 'N':
                    e.preventDefault();
                    this.cancel();
                    break;
            }
        }
    },

    // =========================================================================
    // CLICK COOLDOWN
    // =========================================================================
    // Briefly block clicks on a morphing button. Use case: after a button label
    // swaps (e.g. "ok" → "quit" when exiting a submode), a rapid second click
    // would fire the new action unintentionally. armCooldown installs a
    // capture-phase guard for `ms` milliseconds that swallows clicks before
    // they reach the button's onclick handler.
    //
    // Usage:
    //   document.getElementById('btnQuit').textContent = 'quit';
    //   GMTools.armClickCooldown(document.getElementById('btnQuit'));

    armClickCooldown(button, ms = 300) {
        if (!button) return;
        const block = (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
        };
        button.addEventListener('click', block, true);
        setTimeout(() => button.removeEventListener('click', block, true), ms);
    },

    // =========================================================================
    // SESSION PERSISTENCE
    // =========================================================================
    // Per-editor "what was I working on" buffer in localStorage. Editors call
    // .save() on each edit (typically debounced) and .load() on init to restore.
    // The shape of the saved blob is editor-specific — usually serialized bytes
    // of the current item + filename + small bits of UI state.
    //
    // Disks live in their own shared pool (see GMDisk). The session is the
    // *unsaved* in-progress work alongside that.
    //
    // Usage:
    //   GMTools.session.save('sprite-maker', { bytes, fileName, frame, quad });
    //   const restored = GMTools.session.load('sprite-maker'); // or null
    //   GMTools.session.clear('sprite-maker');
    //
    //   // Convenience: debounced saver — pass a function that builds the blob,
    //   // call the returned function on every edit, it writes once per idle period.
    //   const saveSession = GMTools.session.debouncedSaver('sprite-maker', () => ({
    //       bytes: bytesToBase64(currentSprite.serialize()),
    //       fileName: currentSpriteFileName,
    //       frame: currentFrame
    //   }));
    //   // call saveSession() after any edit; the write fires 500ms after the last call.

    session: {
        _key(name) { return 'gm_session_' + name; },

        save(name, blob) {
            try {
                localStorage.setItem(this._key(name), JSON.stringify(blob));
            } catch (e) {
                console.warn('GMTools.session.save failed:', e.message);
            }
        },

        load(name) {
            const raw = localStorage.getItem(this._key(name));
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch (e) {
                console.warn('GMTools.session.load: corrupt session, ignoring');
                return null;
            }
        },

        clear(name) {
            localStorage.removeItem(this._key(name));
        },

        debouncedSaver(name, build, ms = 500) {
            let timer = null;
            return () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    try {
                        const blob = build();
                        if (blob) this.save(name, blob);
                    } catch (e) {
                        console.warn('GMTools.session: build failed:', e.message);
                    }
                }, ms);
            };
        },

        // Convert Uint8Array → base64 in chunks so large payloads don't blow
        // String.fromCharCode.apply's argument limit. Same trick as gmDisk uses.
        bytesToBase64(bytes) {
            const CHUNK = 0x8000;
            let binary = '';
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(binary);
        },

        base64ToBytes(b64) {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
    },

    // =========================================================================
    // SAVE DIALOG
    // =========================================================================
    // In-app GM-style save UI: filename input with yes/no, overwrite confirmation
    // step when the name collides with an existing file. Used by sprite-maker
    // and scene-maker; both used to carry near-identical copies of this code.
    //
    // The dialog renders into a caller-provided element. Existence checking
    // and serialisation are delegated via callbacks — the dialog only owns the
    // UI, keyboard handling, validation, and overwrite prompt.
    //
    // Usage:
    //   GMTools.saveDialog.enter({
    //       disk,                     // GMDisk instance (used to check for collisions)
    //       fileType,                 // GMDisk.FILE_TYPES.X (provides the extension)
    //       messageArea,              // DOM element to render the prompt into
    //       suggestedName: 'PLAYER',  // initial value (without extension)
    //       onSave:  (fullFileName) => boolean,  // serialise+save; return success
    //       onExit:  () => void                  // called after exit (success or cancel)
    //   });

    saveDialog: {
        _active: false,
        _options: null,
        _fileName: '',
        _confirmingOverwrite: false,
        _keyHandler: null,

        isActive() { return this._active; },
        confirmingOverwrite() { return this._confirmingOverwrite; },

        enter(options) {
            if (this._active) return;
            this._active = true;
            this._options = options;
            this._fileName = (options.suggestedName || '').toUpperCase();
            this._confirmingOverwrite = false;

            this._keyHandler = (e) => this._onKey(e);
            document.addEventListener('keydown', this._keyHandler);

            this._renderNamePrompt();
        },

        cancel() {
            if (!this._active) return;
            this._exit();
        },

        confirm() {
            if (!this._active) return;
            if (this._confirmingOverwrite) { this._doSave(); return; }

            // Don't trim — internal spaces (and even leading/trailing within
            // the 6-char slot) are significant. Only check that there's any
            // non-whitespace content at all.
            if (!this._fileName.trim()) {
                // Flash and re-prompt — keep the user in save mode
                GMTools.flashingMessage.show(this._options.messageArea, 'enter a name');
                setTimeout(() => {
                    GMTools.flashingMessage.hide();
                    if (this._active) this._renderNamePrompt();
                }, 1500);
                return;
            }

            const ext = (this._options.fileType.extension || '').replace(/^\//, '');
            const fullName = ext ? GMTools.formatFileName(this._fileName, ext) : this._fileName.toUpperCase();
            const exists = this._options.disk.listFiles(this._options.fileType)
                .some(f => f.fileName.toUpperCase() === fullName.toUpperCase());
            if (exists) this._renderOverwritePrompt(this._fileName.toUpperCase());
            else this._doSave();
        },

        _doSave() {
            const ext = (this._options.fileType.extension || '').replace(/^\//, '');
            const fullName = ext ? GMTools.formatFileName(this._fileName, ext) : this._fileName.toUpperCase();
            const success = this._options.onSave(fullName);
            if (success) {
                this._exit();
            } else {
                // Flash and re-prompt at the name-entry step
                GMTools.flashingMessage.show(this._options.messageArea, 'disk error');
                setTimeout(() => {
                    GMTools.flashingMessage.hide();
                    if (this._active) {
                        this._confirmingOverwrite = false;
                        this._renderNamePrompt();
                    }
                }, 1500);
            }
        },

        _exit() {
            if (!this._active) return;
            this._active = false;
            const opts = this._options;
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
            this._options = null;
            this._fileName = '';
            this._confirmingOverwrite = false;
            if (opts.messageArea) opts.messageArea.innerHTML = '';
            if (opts.onExit) opts.onExit();
        },

        _renderNamePrompt() {
            const area = this._options.messageArea;
            const display = this._fileName.toLowerCase().padEnd(6, ' ').substring(0, 6).trim();
            area.innerHTML =
                '<span style="color: var(--c64-yellow)">save </span>' +
                '<input type="text" class="save-filename" maxlength="6" ' +
                // width: 7ch (one ch wider than maxlength) so the caret has room
                // after the 6th character — at exactly 6ch the last typed char
                // gets visually clipped by the cursor.
                'style="font-family: inherit; font-size: inherit; width: 7ch; ' +
                'color: var(--c64-white); background: var(--c64-blue); border: none; ' +
                'padding: 0 2px; text-transform: lowercase; outline: none;" ' +
                'value="' + display + '">' +
                '<span style="color: var(--c64-yellow)">?</span><br>' +
                '<span class="save-yes gm-yes-no">yes</span>' +
                '<span style="display: inline-block; width: 80px"></span>' +
                '<span class="save-no gm-yes-no">no</span>';

            const input = area.querySelector('.save-filename');
            input.focus();
            input.select();
            input.addEventListener('input', (e) => {
                this._fileName = e.target.value.toUpperCase();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); this.confirm(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); }
            });
            area.querySelector('.save-yes').addEventListener('click', () => this.confirm());
            area.querySelector('.save-no').addEventListener('click', () => this.cancel());
        },

        _renderOverwritePrompt(name) {
            this._confirmingOverwrite = true;
            const area = this._options.messageArea;
            area.innerHTML =
                '<span style="color: var(--c64-yellow)">overwrite </span>' +
                '<span style="color: var(--c64-white); background: var(--c64-blue); padding: 0 4px">' + name.toLowerCase() + '</span>' +
                '<span style="color: var(--c64-yellow)">?</span><br>' +
                '<span class="save-yes gm-yes-no">yes</span>' +
                '<span style="display: inline-block; width: 80px"></span>' +
                '<span class="save-no gm-yes-no">no</span>';
            area.querySelector('.save-yes').addEventListener('click', () => this.confirm());
            area.querySelector('.save-no').addEventListener('click', () => this._cancelOverwrite());
        },

        _cancelOverwrite() {
            this._confirmingOverwrite = false;
            this._renderNamePrompt();
        },

        _onKey(e) {
            if (!this._active) return;
            if (this._confirmingOverwrite) {
                switch (e.key) {
                    case 'Enter': case 'y': case 'Y':
                        e.preventDefault(); this.confirm(); break;
                    case 'Escape': case 'n': case 'N':
                        e.preventDefault(); this._cancelOverwrite(); break;
                }
                return;
            }
            // Input handles its own Enter/Escape; this catches y/n outside the input
            if (document.activeElement === document.querySelector('.save-filename')) return;
            switch (e.key) {
                case 'Enter': case 'y': case 'Y':
                    e.preventDefault(); this.confirm(); break;
                case 'Escape': case 'n': case 'N':
                    e.preventDefault(); this.cancel(); break;
            }
        }
    },

    // =========================================================================
    // FLASHING MESSAGE
    // =========================================================================
    // Displays a message that flashes between two colors. This is the *only*
    // genuinely flashing API in the suite. For the other "message" patterns:
    //   - disk.showInfoMessage(text, opts): static info text in the disk popup's
    //     info-bar that auto-clears after a timeout.
    //   - per-page showMessage / clearMessage (scene-maker, sprite-maker):
    //     static text in the page's own message area, no auto-clear.
    // Use flashingMessage when you specifically want the alternating-color
    // alarm effect; use the others for static informational text.
    //
    // Usage:
    //   GMTools.flashingMessage.show(element, 'no files on disk', {
    //       color1: 'yellow',      // CSS color or C64 index
    //       color2: 'lt-blue',     // CSS color or C64 index
    //       interval: 250          // ms between color changes (default 250 for 2Hz)
    //   });
    //   GMTools.flashingMessage.hide();

    flashingMessage: {
        _element: null,
        _intervalId: null,
        _isColor1: true,

        /**
         * Show a flashing message
         */
        show(element, text, options = {}) {
            this.hide(); // Clear any existing

            this._element = element;

            // Default colors: yellow and lt-blue (C64 palette)
            const color1 = options.color1 || 'var(--c64-yellow)';
            const color2 = options.color2 || 'var(--c64-lt-blue)';
            const interval = options.interval || 250; // 250ms = 2 flashes per second

            element.textContent = text;
            element.style.color = color1;
            this._isColor1 = true;

            this._intervalId = setInterval(() => {
                this._isColor1 = !this._isColor1;
                element.style.color = this._isColor1 ? color1 : color2;
            }, interval);
        },

        /**
         * Hide the flashing message and clear interval
         */
        hide() {
            if (this._intervalId) {
                clearInterval(this._intervalId);
                this._intervalId = null;
            }
            if (this._element) {
                this._element.style.color = '';
                this._element = null;
            }
        },

        /**
         * Check if a message is currently flashing
         */
        isActive() {
            return this._intervalId !== null;
        }
    },

    // =========================================================================
    // QUIT MENU
    // =========================================================================
    // Shows a navigation menu popup for switching between GM tools.
    // Gray3 box with lopsided border, blue text links.
    // Click outside or press Escape to dismiss.
    //
    // Usage:
    //   GMTools.quitMenu.show();

    quitMenu: {
        _overlay: null,
        _keyHandler: null,

        show() {
            if (this._overlay) return; // Already showing

            // Attach to the tool's #screen if present so the menu covers exactly
            // the tool's work area; otherwise fall back to a full-viewport overlay.
            const host = document.getElementById('screen') || document.body;
            const screenFit = host.id === 'screen';

            this._overlay = document.createElement('div');
            this._overlay.className = 'quit-menu-overlay' + (screenFit ? ' screen-fit' : '');
            this._overlay.innerHTML = `
                <div class="quit-menu-outer">
                    <div class="quit-menu-container">
                        <div class="quit-menu-box">
                            <a href="editor.html">editor</a>
                            <a href="sprite-maker.html">sprite maker</a>
                            <a href="sound-maker.html">sound maker</a>
                            <a href="scene-maker.html">scene maker</a>
                            <a href="music-maker.html">music maker</a>
                        </div>
                    </div>
                </div>
            `;

            // Click outside menu box to dismiss
            this._overlay.onclick = (e) => {
                const cl = e.target.classList;
                if (e.target === this._overlay || cl.contains('quit-menu-outer') || cl.contains('quit-menu-container')) {
                    this.hide();
                }
            };

            // Escape to dismiss
            this._keyHandler = (e) => {
                if (e.key === 'Escape') {
                    this.hide();
                    e.preventDefault();
                }
            };

            host.appendChild(this._overlay);
            document.addEventListener('keydown', this._keyHandler);
        },

        hide() {
            if (this._overlay) {
                this._overlay.remove();
                this._overlay = null;
            }
            if (this._keyHandler) {
                document.removeEventListener('keydown', this._keyHandler);
                this._keyHandler = null;
            }
        },

        isOpen() {
            return this._overlay !== null;
        }
    }
};
