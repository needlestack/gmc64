// gmEditor.js - GameMaker Program Editor (Phase 1: Inline Editing)
//
// This module provides inline editing of GM instructions with structured fields:
// - Dropdowns for constrained choices (variables, sprites, colors, etc.)
// - Numeric inputs for number values
// - Text inputs for strings (comments, print statements)
//
// Dependencies:
// - gmOpcodes.js (opcode definitions with args array)
// - gmParser.js (currentProgramData)
// - c64lib.js (c64ColorNames)

const gmEditor = {
    // Currently editing instruction index (-1 = none)
    editingIndex: -1,

    // Reference to the listing container element
    listingContainer: null,

    // Callback when instruction is modified
    onInstructionChanged: null,

    // Callback when user starts editing (to pause/stop VM)
    onEditStart: null,

    // Initialize the editor
    init(containerId, onChanged, onEditStart) {
        this.listingContainer = document.getElementById(containerId);
        this.onInstructionChanged = onChanged;
        this.onEditStart = onEditStart;

        // Add editor-specific styles
        this.addStyles();

        // Click outside the listing cancels editing/inserting
        document.addEventListener('click', (e) => {
            if (!this.listingContainer.contains(e.target) && this.currentProgramData) {
                if (this.editingIndex >= 0) {
                    this.cancelEditing(this.currentProgramData);
                }
                if (this.insertingIndex >= 0) {
                    this.cancelInserting(this.currentProgramData);
                }
            }
        });
    },

    // Add CSS styles for the editor
    addStyles() {
        if (document.getElementById('gmEditorStyles')) return;

        const style = document.createElement('style');
        style.id = 'gmEditorStyles';
        style.textContent = `
            .gm-listing {
                font-family: monospace;
                font-size: 12px;
                background: #1a1a2e;
                color: #b8b8b8;
                padding: 5px;
                height: 100%;
                overflow-y: auto;
                text-align: left;
            }
            .gm-instruction {
                padding: 0px 4px;
                cursor: default;
                white-space: pre;
                border: 1px solid transparent;
                line-height: 1.2;
            }
            .gm-instruction:hover {
                background: #2a2a4e;
            }
            .gm-instruction.editing {
                background: #2a3a5e;
                border: 1px solid #4a6a9e;
                white-space: normal;
            }
            .gm-instruction.if-block {
                color: #7a9ec9;
            }
            .gm-instruction.else-block {
                color: #9a7ec9;
            }
            .gm-label {
                color: #e8c547;
            }
            .gm-editor-row {
                display: inline-flex;
                align-items: center;
                gap: 3px;
                flex-wrap: nowrap;
            }
            .gm-editor-row select,
            .gm-editor-row input {
                font-family: monospace;
                font-size: 11px;
                background: #2a2a4e;
                color: #e8e8e8;
                border: 1px solid #4a4a6e;
                padding: 1px 3px;
            }
            .gm-editor-row input[type="number"] {
                width: 45px;
            }
            .gm-editor-row input[type="text"] {
                width: 150px;
            }
            .gm-editor-row select {
                min-width: 50px;
            }
            .gm-editor-row .gm-text {
                color: #888;
            }
            .gm-editor-row .gm-save-btn,
            .gm-editor-row .gm-cancel-btn {
                padding: 1px 6px;
                cursor: pointer;
                font-size: 10px;
            }
            .gm-editor-row .gm-save-btn {
                background: #3a5a3a;
                border: 1px solid #5a8a5a;
                color: #afc;
            }
            .gm-editor-row .gm-cancel-btn {
                background: #5a3a3a;
                border: 1px solid #8a5a5a;
                color: #fca;
            }
            .gm-insert-btn {
                display: inline-block;
                font-size: 16px;
                line-height: 1;
                color: #4a4;
                cursor: pointer;
                vertical-align: middle;
            }
            .gm-insert-btn:hover {
                color: #6c6;
            }
            .gm-insert-row {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 2px 4px;
                background: #2a3a2a;
                border: 1px solid #4a6a4a;
            }
            .gm-insert-row input {
                font-family: monospace;
                font-size: 11px;
                background: #1a2a1a;
                color: #e8e8e8;
                border: 1px solid #4a6a4a;
                padding: 2px 4px;
                width: 250px;
            }
            .gm-insert-dropdown {
                position: fixed;
                background: #1a2a1a;
                border: 1px solid #4a6a4a;
                max-height: 200px;
                overflow-y: auto;
                z-index: 100;
                width: 250px;
            }
            .gm-insert-dropdown div {
                padding: 2px 6px;
                cursor: pointer;
                font-family: monospace;
                font-size: 11px;
                color: #b8b8b8;
            }
            .gm-insert-dropdown div:hover,
            .gm-insert-dropdown div.selected {
                background: #3a5a3a;
                color: #fff;
            }
            .gm-delete-btn {
                display: inline-block;
                font-size: 16px;
                line-height: 1;
                color: #a44;
                cursor: pointer;
                margin-left: auto;
                vertical-align: middle;
                flex-shrink: 0;
            }
            .gm-delete-btn:hover {
                color: #c66;
            }
        `;
        document.head.appendChild(style);
    },

    // Check if opcode is an "if" statement
    isIfOpcode(opcode) {
        return (opcode >= 0x13 && opcode <= 0x1B) ||
               opcode === 0x4A || opcode === 0x4B || opcode === 0x4C;
    },

    // Render the program listing as editable elements
    renderListing(programData) {
        if (!this.listingContainer || !programData) return;

        this.listingContainer.innerHTML = '';
        this.listingContainer.className = 'gm-listing';

        const instructions = programData.instructions;
        let indentLevel = 0;

        for (let i = 0; i < instructions.length; i++) {
            const instr = instructions[i];
            const div = document.createElement('div');
            div.className = 'gm-instruction';
            div.dataset.index = i;

            // Adjust indent before rendering this instruction
            // endif (0x55) and otherwise (0x54) decrease indent before rendering
            if (instr.opcode === 0x55 || instr.opcode === 0x54) {
                indentLevel = Math.max(0, indentLevel - 1);
            }

            const currentIndent = indentLevel;

            // Add special styling for control flow
            if (this.isIfOpcode(instr.opcode)) {
                div.classList.add('if-block');
            } else if (instr.opcode === 0x54) {
                div.classList.add('else-block');
            }

            // Insert button
            const insertBtn = document.createElement('span');
            insertBtn.className = 'gm-insert-btn';
            insertBtn.textContent = '⊕';
            insertBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.startInserting(i, programData);
            });

            // Format: "lXXX  instruction" or "      instruction"
            let labelStr = '     ';
            if (instr.label) {
                labelStr = `<span class="gm-label">l${instr.label.toString().padStart(3, '0')}</span>`;
            }

            // Add indentation
            const indentStr = '  '.repeat(currentIndent);

            div.innerHTML = '';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.appendChild(insertBtn);
            const contentSpan = document.createElement('span');
            contentSpan.innerHTML = `${labelStr}${indentStr}  ${this.escapeHtml(instr.instructionName)}`;
            contentSpan.style.flexGrow = '1';
            contentSpan.style.cursor = 'pointer';
            contentSpan.style.paddingLeft = '4px';
            div.appendChild(contentSpan);

            // Delete button
            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'gm-delete-btn';
            deleteBtn.textContent = '⊖';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteInstruction(i, programData);
            });
            div.appendChild(deleteBtn);

            // Click to edit (on content, not insert/delete buttons)
            const idx = i; // Capture index in closure
            contentSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                this.startEditing(idx, programData);
            });

            this.listingContainer.appendChild(div);

            // Adjust indent after rendering this instruction
            // if statements and otherwise increase indent after rendering
            if (this.isIfOpcode(instr.opcode) || instr.opcode === 0x54) {
                indentLevel++;
            }
        }

        // Add final insert button for appending at end
        const finalDiv = document.createElement('div');
        finalDiv.className = 'gm-instruction';
        const finalInsertBtn = document.createElement('span');
        finalInsertBtn.className = 'gm-insert-btn';
        finalInsertBtn.textContent = '⊕';
        finalInsertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startInserting(instructions.length, programData);
        });
        finalDiv.appendChild(finalInsertBtn);
        finalDiv.appendChild(document.createTextNode(' (end)'));
        this.listingContainer.appendChild(finalDiv);
    },

    // Start editing an instruction
    startEditing(index, programData) {
        // Notify that editing is starting (so VM can be paused/stopped)
        if (this.onEditStart) {
            this.onEditStart();
        }

        // Cancel any existing edit
        if (this.editingIndex >= 0) {
            this.cancelEditing(programData);
        }

        this.editingIndex = index;
        this.currentProgramData = programData; // Store for button handlers
        const instr = programData.instructions[index];
        const div = this.listingContainer.children[index];

        div.classList.add('editing');
        div.innerHTML = this.buildEditorUI(instr, programData);

        // Attach button event listeners
        const saveBtn = div.querySelector('.gm-btn-save');
        const cancelBtn = div.querySelector('.gm-btn-cancel');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.saveEditing(this.currentProgramData);
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cancelEditing(this.currentProgramData);
            });
        }

        // Attach keyboard and event listeners to all inputs
        const inputs = div.querySelectorAll('input, select');
        inputs.forEach(input => {
            // Stop propagation on all keyboard/mouse events to prevent interference
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.saveEditing(this.currentProgramData);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.cancelEditing(this.currentProgramData);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.saveAndMoveTo(this.editingIndex - 1);
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.saveAndMoveTo(this.editingIndex + 1);
                }
            });
            input.addEventListener('keyup', (e) => e.stopPropagation());
            input.addEventListener('keypress', (e) => e.stopPropagation());
            input.addEventListener('click', (e) => e.stopPropagation());
        });

        // Focus first input
        const firstInput = div.querySelector('input, select');
        if (firstInput) firstInput.focus();
    },

    // Save current edit and move to another instruction
    saveAndMoveTo(newIndex) {
        if (!this.currentProgramData) return;
        const maxIndex = this.currentProgramData.instructions.length - 1;
        if (newIndex < 0 || newIndex > maxIndex) return;

        this.saveEditing(this.currentProgramData);
        this.startEditing(newIndex, this.currentProgramData);
    },

    // Currently inserting at index (-1 = none)
    insertingIndex: -1,

    // Build list of opcodes for insert dropdown
    getOpcodeList() {
        if (this._opcodeList) return this._opcodeList;

        this._opcodeList = [];
        for (const [opcode, def] of Object.entries(gmOpcodes)) {
            if (def.name) { // Skip empty/nop
                this._opcodeList.push({
                    opcode: parseInt(opcode),
                    name: def.name
                });
            }
        }
        // Sort alphabetically by name
        this._opcodeList.sort((a, b) => a.name.localeCompare(b.name));
        return this._opcodeList;
    },

    // Start inserting a new instruction at index
    startInserting(index, programData) {
        // Notify that editing is starting (so VM can be paused/stopped)
        if (this.onEditStart) {
            this.onEditStart();
        }

        // Cancel any existing edit or insert
        if (this.editingIndex >= 0) {
            this.cancelEditing(programData);
        }
        if (this.insertingIndex >= 0) {
            this.cancelInserting(programData);
        }

        this.insertingIndex = index;
        this.currentProgramData = programData;

        // Insert a placeholder row
        const targetDiv = this.listingContainer.children[index];
        const insertDiv = document.createElement('div');
        insertDiv.className = 'gm-instruction gm-insert-row';
        insertDiv.innerHTML = `
            <input type="text" class="gm-insert-search" placeholder="Type to search instructions...">
            <button class="gm-cancel-btn gm-btn-cancel">Cancel</button>
        `;
        this.listingContainer.insertBefore(insertDiv, targetDiv);

        // Create dropdown (appended to body for proper positioning)
        const dropdown = document.createElement('div');
        dropdown.className = 'gm-insert-dropdown';
        document.body.appendChild(dropdown);
        this.currentDropdown = dropdown; // Store reference for cleanup

        const input = insertDiv.querySelector('.gm-insert-search');
        const cancelBtn = insertDiv.querySelector('.gm-btn-cancel');

        // Position dropdown below input
        const positionDropdown = () => {
            const inputRect = input.getBoundingClientRect();
            dropdown.style.left = inputRect.left + 'px';
            dropdown.style.top = inputRect.bottom + 'px';
        };
        positionDropdown();

        // Populate dropdown
        this.selectedDropdownIndex = 0;
        this.updateInsertDropdown(dropdown, '', programData);

        // Event handlers
        input.addEventListener('input', () => {
            this.selectedDropdownIndex = 0;
            this.updateInsertDropdown(dropdown, input.value, programData);
        });

        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            const items = dropdown.querySelectorAll('div');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedDropdownIndex = Math.min(this.selectedDropdownIndex + 1, items.length - 1);
                this.highlightDropdownItem(dropdown);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedDropdownIndex = Math.max(this.selectedDropdownIndex - 1, 0);
                this.highlightDropdownItem(dropdown);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selected = dropdown.querySelector('.selected');
                if (selected) {
                    this.confirmInsert(parseInt(selected.dataset.opcode), programData);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelInserting(programData);
            }
        });

        input.addEventListener('keyup', (e) => e.stopPropagation());
        input.addEventListener('keypress', (e) => e.stopPropagation());

        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.cancelInserting(programData);
        });

        input.focus();
    },

    // Update the insert dropdown based on search filter
    updateInsertDropdown(dropdown, filter, programData) {
        const opcodes = this.getOpcodeList();
        const lowerFilter = filter.toLowerCase();

        // Separate matches: starts-with first, then contains
        const startsWithMatches = [];
        const containsMatches = [];
        for (const op of opcodes) {
            const lowerName = op.name.toLowerCase();
            if (lowerName.startsWith(lowerFilter)) {
                startsWithMatches.push(op);
            } else if (lowerName.includes(lowerFilter)) {
                containsMatches.push(op);
            }
        }
        const sortedOpcodes = [...startsWithMatches, ...containsMatches];

        dropdown.innerHTML = '';
        let count = 0;
        for (const op of sortedOpcodes) {
            const div = document.createElement('div');
            div.textContent = op.name;
            div.dataset.opcode = op.opcode;
            if (count === this.selectedDropdownIndex) {
                div.classList.add('selected');
            }
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                this.confirmInsert(op.opcode, programData);
            });
            dropdown.appendChild(div);
            count++;
        }
    },

    // Highlight selected dropdown item
    highlightDropdownItem(dropdown) {
        const items = dropdown.querySelectorAll('div');
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === this.selectedDropdownIndex);
            if (i === this.selectedDropdownIndex) {
                item.scrollIntoView({ block: 'nearest' });
            }
        });
    },

    // Confirm insert and switch to edit mode
    confirmInsert(opcode, programData) {
        const index = this.insertingIndex;
        this.insertingIndex = -1;

        // Remove dropdown from body
        if (this.currentDropdown && this.currentDropdown.parentNode) {
            this.currentDropdown.parentNode.removeChild(this.currentDropdown);
        }
        this.currentDropdown = null;

        // Create new instruction with default values
        const opDef = gmOpcodes[opcode];
        const newInstr = {
            label: 0,
            arg1: opDef.args && opDef.args[0] === 'var' ? 1 : 0,
            opcode: opcode,
            arg2: opDef.args && opDef.args[1] === 'var' ? 1 : 0,
            instructionName: opDef.name
        };

        // Insert into instructions array
        programData.instructions.splice(index, 0, newInstr);

        // Re-render and start editing the new instruction
        this.renderListing(programData);
        this.startEditing(index, programData);

        // Notify callback
        if (this.onInstructionChanged) {
            this.onInstructionChanged(programData);
        }
    },

    // Cancel inserting
    cancelInserting(programData) {
        if (this.insertingIndex < 0) return;
        this.insertingIndex = -1;
        // Remove dropdown from body
        if (this.currentDropdown && this.currentDropdown.parentNode) {
            this.currentDropdown.parentNode.removeChild(this.currentDropdown);
        }
        this.currentDropdown = null;
        this.renderListing(programData);
    },

    // Delete an instruction
    deleteInstruction(index, programData) {
        // Cancel any editing first
        if (this.editingIndex >= 0) {
            this.cancelEditing(programData);
        }

        // Remove from instructions array
        programData.instructions.splice(index, 1);

        // Re-render
        this.renderListing(programData);

        // Notify callback
        if (this.onInstructionChanged) {
            this.onInstructionChanged(programData);
        }
    },

    // Build the editor UI for an instruction
    buildEditorUI(instr, programData) {
        const opcode = instr.opcode;
        const opDef = gmOpcodes[opcode];

        // Label part
        let labelStr = '     ';
        if (instr.label) {
            labelStr = `<span class="gm-label">l${instr.label.toString().padStart(3, '0')}</span>`;
        }

        // If no opcode definition or no args, just show text
        if (!opDef || !opDef.args || opDef.args.length === 0) {
            return `${labelStr}  <span class="gm-editor-row">
                <span class="gm-text">${this.escapeHtml(instr.instructionName)}</span>
                <button class="gm-cancel-btn gm-btn-cancel">Close</button>
            </span>`;
        }

        // Parse template and build editor fields
        const template = opDef.template;
        const args = opDef.args;

        let html = `${labelStr}  <span class="gm-editor-row">`;
        html += this.buildFieldsFromTemplate(template, args, instr, programData);
        html += ` <button class="gm-save-btn gm-btn-save">OK</button>`;
        html += ` <button class="gm-cancel-btn gm-btn-cancel">Cancel</button>`;
        html += `</span>`;

        return html;
    },

    // Build input fields from template
    buildFieldsFromTemplate(template, args, instr, programData) {
        let html = '';
        let lastIndex = 0;

        // Match {type:argNum} patterns
        const regex = /\{([^:}]+):(\d)\}/g;
        let match;

        while ((match = regex.exec(template)) !== null) {
            // Add literal text before this match
            if (match.index > lastIndex) {
                const text = template.substring(lastIndex, match.index);
                html += `<span class="gm-text">${this.escapeHtml(text)}</span>`;
            }

            const type = match[1];
            const argNum = parseInt(match[2]);
            const value = argNum === 1 ? instr.arg1 : instr.arg2;

            html += this.buildFieldForType(type, argNum, value, programData, instr);

            lastIndex = match.index + match[0].length;
        }

        // Add remaining literal text
        if (lastIndex < template.length) {
            const text = template.substring(lastIndex);
            html += `<span class="gm-text">${this.escapeHtml(text)}</span>`;
        }

        return html;
    },

    // Build an input field for a specific type
    buildFieldForType(type, argNum, value, programData, instr) {
        const inputName = `arg${argNum}`;

        switch (type) {
            case 'var':
                return this.buildVarDropdown(inputName, value);

            case 'num':
            case 'rndRange':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="255">`;

            case 'label':
                return `<input type="number" name="${inputName}" value="${value}" min="1" max="255">`;

            case 'sprite':
                // 0-based in bytecode, display as 1-based
                return this.buildDropdown(inputName, value, this.range(0, 7), v => `sprite ${v + 1}`);

            case 'hitTarget':
                // 0-7 = sprite 1-8, 8 = anyone, 9 = clr2/3
                return this.buildDropdown(inputName, value, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], v => {
                    if (v <= 7) return `sprite ${v + 1}`;
                    if (v === 8) return 'anyone';
                    if (v === 9) return 'clr2/3';
                    return `sprite ${v + 1}`;
                });

            case 'scene':
            case 'sceneTarget':
                return this.buildDropdown(inputName, value, [0, 1, 2], v =>
                    v === 0 ? 'scene 1' : v === 1 ? 'scene 2' : 'both');

            case 'score':
                return this.buildDropdown(inputName, value, [1, 2], v => `score ${v}`);

            case 'color':
                return this.buildDropdown(inputName, value, this.range(0, 15), v =>
                    c64ColorNames[v] || `color ${v}`);

            case 'colorSlot':
                return this.buildDropdown(inputName, value, [1, 2, 3], v => `slot ${v}`);

            case 'sceneColorSlot':
                return this.buildDropdown(inputName, value, [0, 1, 2, 3], v => String(v).padStart(2, '0'));

            case 'color23':
                return this.buildDropdown(inputName, value, [1, 2], v => String(v + 1));

            case 'colorName':
                return this.buildDropdown(inputName, value, this.range(0, 15), v =>
                    c64ColorNames[v] || `color ${v}`);

            case 'joystick':
                return this.buildDropdown(inputName, value, [0, 1], v => `joystick ${v + 1}`);

            case 'joyDir':
                return this.buildDropdown(inputName, value, [0, 1, 2, 3, 4], v =>
                    ['up', 'down', 'left', 'right', 'none'][v] || `dir ${v}`);

            case 'button':
                return this.buildDropdown(inputName, value, [0, 1], v => `button ${v + 1}`);

            case 'channel':
                return this.buildDropdown(inputName, value, [0, 1, 2], v => `channel ${v + 1}`);

            case 'onOff':
                return this.buildDropdown(inputName, value, [0, 1], v => v === 0 ? 'off' : 'on');

            case 'alwaysOnce':
                return this.buildDropdown(inputName, value, [0, 1], v => v === 0 ? 'always' : 'once');

            case 'overUnder':
                return this.buildDropdown(inputName, value, [0, 1], v => v === 0 ? 'over' : 'under');

            case 'direction':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="255">`;

            case 'animSpeed':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="32">`;

            case 'row':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="24">`;

            case 'col':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="19">`;

            case 'volume':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="15">`;

            case 'seconds':
                // Display with decimal (25 -> 2.5), store as integer
                const displaySeconds = (value / 10).toFixed(1);
                return `<input type="text" name="${inputName}" value="${displaySeconds}" class="seconds-input" data-raw="${value}" pattern="[0-9]*\\.?[0-9]?" size="5"> seconds`;

            case 'scoreValue':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="100">`;

            case 'scoreComp':
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="255"> <span class="gm-text">(×1000)</span>`;

            case 'spriteName':
            case 'sceneName':
            case 'sound':
            case 'song':
                return this.buildDataPageDropdown(inputName, value, type, programData);

            case 'string':
                // Extract string from instructionName (format: "/ comment" or "print text")
                return this.buildStringField(inputName, instr);

            default:
                // Unknown type - show as number
                return `<input type="number" name="${inputName}" value="${value}" min="0" max="255">`;
        }
    },

    // Build a dropdown for variable selection (a-z)
    buildVarDropdown(name, value) {
        let html = `<select name="${name}">`;
        for (let i = 1; i <= 26; i++) {
            const varName = String.fromCharCode(96 + i); // 'a' = 97
            const selected = i === value ? ' selected' : '';
            html += `<option value="${i}"${selected}>${varName}</option>`;
        }
        html += '</select>';
        return html;
    },

    // Build a generic dropdown
    buildDropdown(name, value, options, labelFn) {
        let html = `<select name="${name}">`;
        for (const opt of options) {
            const selected = opt === value ? ' selected' : '';
            html += `<option value="${opt}"${selected}>${labelFn(opt)}</option>`;
        }
        html += '</select>';
        return html;
    },

    // Build a dropdown for data page entries
    buildDataPageDropdown(name, value, type, programData) {
        // Map type to data page entry type
        const typeMap = {
            'spriteName': 'sprite',
            'sceneName': 'scene',
            'sound': 'sound',
            'song': 'song'
        };
        const entryType = typeMap[type];

        let html = `<select name="${name}">`;

        // Find all entries of this type in mediaStore
        if (programData && programData.mediaStore) {
            for (let i = 1; i < programData.mediaStore.length; i++) {
                const entry = programData.mediaStore[i];
                if (entry && entry.type === entryType) {
                    const selected = i === value ? ' selected' : '';
                    html += `<option value="${i}"${selected}>${entry.name}</option>`;
                }
            }
        }

        html += '</select>';
        return html;
    },

    // Build a text field for string values (comments, print statements)
    buildStringField(name, instr) {
        // Extract the string portion from instructionName
        // Comment format: "/ some text here"
        // Print format: "print some text here"
        let text = '';
        const instrName = instr.instructionName || '';

        if (instr.opcode === 0x2B) {
            // Comment - strip "/ " prefix
            text = instrName.startsWith('/ ') ? instrName.substring(2) : instrName;
        } else if (instr.opcode === 0x3B) {
            // Print string - strip "print " prefix
            text = instrName.startsWith('print ') ? instrName.substring(6) : instrName;
        }

        const maxLen = instr.opcode === 0x2B ? 25 : 20; // Comments: 25, Print: 20
        return `<input type="text" name="${name}" value="${this.escapeHtml(text)}" maxlength="${maxLen}" style="width: ${maxLen * 8}px;">`;
    },

    // Helper: generate range array
    range(start, end) {
        const result = [];
        for (let i = start; i <= end; i++) {
            result.push(i);
        }
        return result;
    },

    // Save the current edit
    saveEditing(programData) {
        if (this.editingIndex < 0) return;

        const div = this.listingContainer.children[this.editingIndex];
        const instr = programData.instructions[this.editingIndex];

        // Check if this is a string-type instruction (comment or print string)
        if (instr.opcode === 0x2B || instr.opcode === 0x3B) {
            // Handle string editing - update instructionName directly
            const arg1Input = div.querySelector('[name="arg1"]');
            if (arg1Input) {
                const newText = arg1Input.value;
                if (instr.opcode === 0x2B) {
                    instr.instructionName = `/ ${newText}`;
                } else {
                    instr.instructionName = `print ${newText}`;
                    // Update printBytes for VM execution
                    instr.printBytes = this.encodeStringToBytes(newText, 20);
                }
            }
        } else {
            // Handle numeric argument editing
            const arg1Input = div.querySelector('[name="arg1"]');
            const arg2Input = div.querySelector('[name="arg2"]');

            if (arg1Input) {
                if (arg1Input.classList.contains('seconds-input')) {
                    // Convert decimal seconds back to integer (2.5 -> 25), clamp to 255 max
                    instr.arg1 = Math.min(255, Math.round(parseFloat(arg1Input.value) * 10) || 0);
                } else {
                    instr.arg1 = parseInt(arg1Input.value) || 0;
                }
            }
            if (arg2Input) {
                if (arg2Input.classList.contains('seconds-input')) {
                    // Convert decimal seconds back to integer (2.5 -> 25), clamp to 255 max
                    instr.arg2 = Math.min(255, Math.round(parseFloat(arg2Input.value) * 10) || 0);
                } else {
                    instr.arg2 = parseInt(arg2Input.value) || 0;
                }
            }

            // Re-format instruction name
            const opDef = gmOpcodes[instr.opcode];
            if (opDef) {
                instr.instructionName = formatInstruction(instr.opcode, instr.arg1, instr.arg2,
                    programData.mediaStore, c64ColorNames);
            }
        }

        // Exit edit mode and refresh display
        this.editingIndex = -1;
        this.renderListing(programData);

        // Notify callback
        if (this.onInstructionChanged) {
            this.onInstructionChanged(programData);
        }
    },

    // Encode a string to bytes for print statements
    // Maps ASCII characters to GM charset indices
    encodeStringToBytes(text, maxLen) {
        const bytes = [];
        for (let i = 0; i < Math.min(text.length, maxLen); i++) {
            const char = text.charAt(i);
            // Simple ASCII to GM charset mapping
            // GM charset: space=32, 0-9=48-57, A-Z=65-90 (uppercase), etc.
            bytes.push(text.charCodeAt(i));
        }
        // Pad with spaces if shorter
        while (bytes.length < maxLen) {
            bytes.push(32); // space
        }
        return bytes;
    },

    // Cancel the current edit
    cancelEditing(programData) {
        if (this.editingIndex < 0) return;

        this.editingIndex = -1;
        this.renderListing(programData);
    },

    // Escape HTML special characters
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
