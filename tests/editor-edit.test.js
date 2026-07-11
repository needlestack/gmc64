/**
 * Editor interaction tests
 *
 * Random functionality tests for editor.html bugs we've encountered. Drives the
 * editor through a real headless browser so focus/blur and event-ordering issues
 * (which JSDOM gets wrong) reflect real-world behavior.
 *
 * Add tests here as bugs come up — each one pins a specific UX guarantee so the
 * suite builds confidence over time.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const EDITOR_URL = `file://${join(PROJECT_ROOT, 'editor.html')}`;

let browser;
let testProgramFixture;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });

    // Test fixture: GMC64I (intro demo) on tests/disks/gmc64-test.d64.
    // Helper is named openEditorWithProgram for clarity.
    const diskBytes = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64'));
    testProgramFixture = {
        diskBase64: diskBytes.toString('base64'),
        fileName: 'GMC64I/PRG'
    };
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openEditorWithProgram({ withRealDisk = false } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    if (withRealDisk) {
        // Seed the shared disk pool with our test disk so the asset
        // picker / findOrAddToMediaStore can find sprites / sounds /
        // songs that live there as standalone files.
        const testBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
        await page.evaluateOnNewDocument((data) => {
            localStorage.clear();
            const id = 'd_test';
            localStorage.setItem('gm_disk_pool_index', JSON.stringify([
                { id, name: 'gmc64-test.d64', diskName: 'LIBRARY' }
            ]));
            localStorage.setItem('gm_disk_pool_data_' + id, data);
            localStorage.setItem('gm_disk_selection_editor', id);
        }, testBase64);
    }

    await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof currentProgramData !== 'undefined' && typeof gmDisk !== 'undefined');

    // Load the fixture program from the disk into the editor (same code
    // path the user takes after picking a file from the disk popup).
    await page.evaluate(async ({ diskBase64, fileName }) => {
        const bin = atob(diskBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const diskObj = new D64(bytes);
        const fileData = diskObj.readFile(fileName);
        globalThis.loadFileByName = (name) => diskObj.readFile(name);
        loadProgramData(fileName, fileData);
    }, testProgramFixture);

    await page.waitForFunction(() => currentProgramData && currentProgramData.instructions && currentProgramData.instructions.length > 0);
    return page;
}

describe('editor — clicking outside a comment/print edit commits the edit', () => {
    test('clicking on another editable field commits an in-flight comment edit', async () => {
        const page = await openEditorWithProgram();

        // Find the first comment instruction (opcode 0x2B). GMC64I has many.
        const commentLineIndex = await page.evaluate(() => {
            return currentProgramData.instructions.findIndex(i => i.opcode === 0x2B);
        });
        expect(commentLineIndex).toBeGreaterThanOrEqual(0);

        // Find any other editable arg field (any instruction with an opcode
        // that has an editable arg — we use the next non-comment line that
        // renders at least one editable-field span).
        const otherLineIndex = await page.evaluate((skipIdx) => {
            const lines = document.querySelectorAll('.program-line');
            for (let i = 0; i < lines.length; i++) {
                if (i === skipIdx) continue;
                const field = lines[i].querySelector('.editable-field');
                if (field && field.dataset.type !== 'comment' && field.dataset.type !== 'print') {
                    return i;
                }
            }
            return -1;
        }, commentLineIndex);
        expect(otherLineIndex).toBeGreaterThanOrEqual(0);

        // Click the comment field to open the text input
        const commentSelector = `.program-line:nth-child(${commentLineIndex + 1}) .editable-field[data-type="comment"]`;
        await page.click(commentSelector);
        await page.waitForSelector('.string-edit-input');

        // Type a distinctive new value (replaces the selected text)
        await page.keyboard.type('hello world');

        // Click another field — this is where the bug was: the other field's
        // mousedown preventDefaults, which used to keep focus on the input
        // and prevent the natural blur from firing.
        const otherSelector = `.program-line:nth-child(${otherLineIndex + 1}) .editable-field:not([data-type="comment"]):not([data-type="print"])`;
        await page.click(otherSelector);

        // Wait for the input to be removed and the listing to re-render
        await page.waitForFunction(() => !document.querySelector('.string-edit-input'));

        // The edit should have been committed to instructionName
        const committed = await page.evaluate((idx) => {
            return currentProgramData.instructions[idx].instructionName;
        }, commentLineIndex);

        expect(committed).toMatch(/^\/ hello world/);

        await page.close();
    });

});

describe('editor — re-selecting an asset picks up its current on-disk version', () => {
    // Regression: findOrAddToMediaStore short-circuited on name+type match and
    // returned the cached entry without re-reading from disk. If the user
    // updated a sprite in sprite-maker and came back to the editor, picking
    // the same sprite via the asset picker silently used the stale parsed copy.
    test('re-picking a sprite reloads its bytes from disk', async () => {
        const page = await openEditorWithProgram({ withRealDisk: true });

        const result = await page.evaluate(() => {
            // Pick the first /SPR on the disk — doesn't matter which.
            const sprFile = gmDisk.listFiles(GMDisk.FILE_TYPES.SPRITE)[0].fileName;
            const displayName = getAssetDisplayName(sprFile);

            // First add — fresh entry in mediaStore.
            const firstIdx = findOrAddToMediaStore(sprFile, displayName, 'spriteName');
            const firstBytes = Array.from(currentProgramData.mediaStore[firstIdx].spriteFileData);

            // Simulate the user saving a new version of the same sprite from
            // sprite-maker: mutate the raw bytes on the underlying D64.
            const original = gmDisk.disk.readFile(sprFile);
            const newBytes = new Uint8Array(original);
            // Flip a pixel byte well past the header so the parsed bitmap differs.
            newBytes[50] = newBytes[50] ^ 0xFF;
            gmDisk.disk.deleteFile(sprFile);
            gmDisk.disk.writeFile(sprFile, newBytes, D64.FILE_TYPE_PRG);

            // Re-pick the same sprite via the same code path the asset picker uses.
            const secondIdx = findOrAddToMediaStore(sprFile, displayName, 'spriteName');
            const secondBytes = Array.from(currentProgramData.mediaStore[secondIdx].spriteFileData);

            return {
                sameIndex: firstIdx === secondIdx,
                bytesDiffer: firstBytes.some((b, i) => b !== secondBytes[i]),
                changedByteOnReload: secondBytes[50]
            };
        });

        expect(result.sameIndex).toBe(true);             // dedup still works
        expect(result.bytesDiffer).toBe(true);           // but data was refreshed
        expect(result.changedByteOnReload).toBeDefined();
        await page.close();
    });
});

describe('editor — changing a multi-quad sprite replaces marker lines instead of stacking them', () => {
    // Helper that runs entirely in-page: builds a mediaStore + two-line program
    // for "sprite 1 is FOO" + "sprite 2 is -FOO", then simulates the user
    // re-picking via the asset picker to swap FOO with a different multi-quad
    // sprite BAR. The UX we want: the second line becomes "sprite 2 is -BAR",
    // not an orphan beneath a freshly-inserted "sprite 2 is -BAR".
    async function setupTwoQuadProgramAndSwap(page, { oldQuads, newQuads }) {
        return page.evaluate(({ oldQuads, newQuads }) => {
            // Build two fake multi-quad sprite entries. handleMultiQuadSprite
            // only reads entry.sprite.sprite.length and entry.name.
            const fakeSprite = (n) => ({ sprite: new Array(n).fill({}) });
            currentProgramData.mediaStore = [null,
                { name: 'FOO',   type: 'sprite', sprite: fakeSprite(oldQuads), spriteFileData: new Uint8Array(8), quadIndex: 0 },
                { name: '-FOO',  type: 'sprite', sprite: null, spriteFileData: null, quadIndex: 1 },
                { name: 'BAR',   type: 'sprite', sprite: fakeSprite(newQuads), spriteFileData: new Uint8Array(8), quadIndex: 0 }
            ];
            // For old multi-quad: also seed extra markers if it had more than 2 quads
            for (let q = 2; q < oldQuads; q++) {
                currentProgramData.mediaStore.push({ name: '-FOO', type: 'sprite', sprite: null, spriteFileData: null, quadIndex: q });
            }
            const fooIdx = 1, fooMark1Idx = 2, barIdx = 3;

            // Find the opcode for "sprite N is NAME" (0x27 in GM).
            const SPRITE_IS_OP = 0x27;
            // Build the program: a sprite-assignment for each quad of FOO.
            currentProgramData.instructions = [
                { opcode: SPRITE_IS_OP, arg1: 1, arg2: fooIdx, label: 0, instructionName: 'sprite 1 is foo' },
                { opcode: SPRITE_IS_OP, arg1: 2, arg2: fooMark1Idx, label: 0, instructionName: 'sprite 2 is -foo' }
            ];
            // For 3/4-quad old sprites, include the extra marker lines.
            for (let q = 2; q < oldQuads; q++) {
                currentProgramData.instructions.push({
                    opcode: SPRITE_IS_OP, arg1: 1 + q,
                    arg2: 3 + (q - 1),  // matches marker indices we pushed above
                    label: 0, instructionName: `sprite ${1 + q} is -foo`
                });
            }

            // Simulate user picking BAR: selectAsset rewrites arg2 then calls handleMultiQuadSprite.
            currentProgramData.instructions[0].arg2 = barIdx;
            handleMultiQuadSprite(currentProgramData.instructions[0], barIdx, 0);

            return currentProgramData.instructions.map(i => ({
                arg1: i.arg1,
                arg2: i.arg2,
                opcode: i.opcode,
                targetName: currentProgramData.mediaStore[i.arg2]?.name
            }));
        }, { oldQuads, newQuads });
    }

    test('swapping 2-quad → 2-quad replaces the marker line in place', async () => {
        const page = await openEditorWithProgram();
        const instrs = await setupTwoQuadProgramAndSwap(page, { oldQuads: 2, newQuads: 2 });

        expect(instrs).toHaveLength(2);                  // No new line inserted
        expect(instrs[0].targetName).toBe('BAR');        // Main is BAR
        expect(instrs[1].targetName).toBe('-BAR');       // Marker is for BAR, not -FOO
        await page.close();
    });

    test('swapping 4-quad → 2-quad trims excess marker lines', async () => {
        const page = await openEditorWithProgram();
        const instrs = await setupTwoQuadProgramAndSwap(page, { oldQuads: 4, newQuads: 2 });

        expect(instrs).toHaveLength(2);
        expect(instrs[1].targetName).toBe('-BAR');
        await page.close();
    });

    test('swapping 2-quad → 3-quad replaces existing and inserts the rest', async () => {
        const page = await openEditorWithProgram();
        const instrs = await setupTwoQuadProgramAndSwap(page, { oldQuads: 2, newQuads: 3 });

        expect(instrs).toHaveLength(3);
        expect(instrs[1].targetName).toBe('-BAR');
        expect(instrs[2].targetName).toBe('-BAR');
        await page.close();
    });

    test('blank lines inside the marker group are consumed (GM blanks halt execution, so they were debris)', async () => {
        const page = await openEditorWithProgram();
        const instrs = await page.evaluate(() => {
            const fakeSprite = (n) => ({ sprite: new Array(n).fill({}) });
            currentProgramData.mediaStore = [null,
                { name: 'FOO',   type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 },
                { name: '-FOO',  type: 'sprite', sprite: null, spriteFileData: null, quadIndex: 1 },
                { name: 'BAR',   type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 }
            ];
            const SPRITE_IS_OP = 0x27;
            currentProgramData.instructions = [
                { opcode: SPRITE_IS_OP, arg1: 1, arg2: 1, label: 0, instructionName: 'sprite 1 is foo' },
                { opcode: 0x00, arg1: 0, arg2: 0, label: 0, instructionName: '' },  // BLANK inside group
                { opcode: SPRITE_IS_OP, arg1: 2, arg2: 2, label: 0, instructionName: 'sprite 2 is -foo' }
            ];
            currentProgramData.instructions[0].arg2 = 3;
            handleMultiQuadSprite(currentProgramData.instructions[0], 3, 0);
            return currentProgramData.instructions.map(i => ({
                opcode: i.opcode,
                arg1: i.arg1, arg2: i.arg2,
                targetName: currentProgramData.mediaStore[i.arg2]?.name
            }));
        });

        // Blank consumed: the group is now compact below the main line.
        expect(instrs).toHaveLength(2);
        expect(instrs[0].targetName).toBe('BAR');
        expect(instrs[1].targetName).toBe('-BAR');
        await page.close();
    });

    test('blank lines AFTER the marker group (not inside it) are preserved', async () => {
        const page = await openEditorWithProgram();
        const instrs = await page.evaluate(() => {
            const fakeSprite = (n) => ({ sprite: new Array(n).fill({}) });
            currentProgramData.mediaStore = [null,
                { name: 'FOO',   type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 },
                { name: '-FOO',  type: 'sprite', sprite: null, spriteFileData: null, quadIndex: 1 },
                { name: 'BAR',   type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 }
            ];
            const SPRITE_IS_OP = 0x27;
            currentProgramData.instructions = [
                { opcode: SPRITE_IS_OP, arg1: 1, arg2: 1, label: 0, instructionName: 'sprite 1 is foo' },
                { opcode: SPRITE_IS_OP, arg1: 2, arg2: 2, label: 0, instructionName: 'sprite 2 is -foo' },
                { opcode: 0x00, arg1: 0, arg2: 0, label: 0, instructionName: '' },  // BLANK after group
                { opcode: SPRITE_IS_OP, arg1: 3, arg2: 1, label: 0, instructionName: 'sprite 3 is foo' }
            ];
            currentProgramData.instructions[0].arg2 = 3;
            handleMultiQuadSprite(currentProgramData.instructions[0], 3, 0);
            return currentProgramData.instructions.map(i => ({ opcode: i.opcode }));
        });

        // Group becomes 2 lines, then the blank is left intact, then the unrelated sprite-3 line.
        expect(instrs).toHaveLength(4);
        expect(instrs[2].opcode).toBe(0x00);  // Blank still there
        await page.close();
    });

    test('plot color instruction (opcode 0x4D) displays 0-3 (not 1-4), matching the runtime range', async () => {
        // Regression: arg1 was typed as `colorSlot` which renders as val+1, so a
        // legitimate `arg1=3` (plot using the bg color, allowed by the runtime
        // and original GM) displayed as "plot color 4" — confusing nonsense.
        // The runtime masks arg1 to 2 bits (0-3); the formatter must do the
        // same and use a 0-based display.
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            return {
                display0: formatInstruction(0x4D, 0, 0, currentProgramData?.mediaStore, c64ColorNames),
                display3: formatInstruction(0x4D, 3, 0, currentProgramData?.mediaStore, c64ColorNames),
                range: getFieldRange('plotColor'),
                defaultArg: getDefaultArg('plotColor')
            };
        });

        expect(result.display0).toBe('plot color 0 to scene 1');
        expect(result.display3).toBe('plot color 3 to scene 1');
        expect(result.range).toEqual({ min: 0, max: 3 });
        // Newly-inserted plot-color instruction defaults to 0 (matches opcode's
        // `name` field "plot color 0 to scene 1"). Without this default the
        // picker would insert a plot color 1 instruction.
        expect(result.defaultArg).toBe(0);
        await page.close();
    });

    test('saving a program with a multi-quad sprite preserves the main sprite name on reload', async () => {
        // Regression: the PRG data section stores sprite names in the GM screen-code
        // charset (a-z = 0x01..0x1A) but sprite-maker's serializeSprite wrote them
        // as ASCII. The editor's serializer copied the .SPR bytes straight through
        // for the main entry, so on reload decodeString saw ASCII letters
        // (out of range) and returned '�'. Markers were unaffected because the
        // editor's serializer overwrites their name bytes via encodeString.
        //
        // To exercise the bug we save the .SPR via sprite-maker.html (the
        // buggy path), then load+save+reload through editor.html.
        const blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
        const sprPage = await browser.newPage();
        sprPage.on('pageerror', err => console.error('sprite-maker page err:', err.message));
        await sprPage.evaluateOnNewDocument((data) => {
            localStorage.clear();
            const id = 'd_t';
            localStorage.setItem('gm_disk_pool_index', JSON.stringify([{id, name: 'BlankDisk.d64', diskName: 'TESTING'}]));
            localStorage.setItem('gm_disk_pool_data_' + id, data);
            localStorage.setItem('gm_disk_selection_sprite-maker', id);
            localStorage.setItem('gm_disk_selection_editor', id);
        }, blankDiskBase64);
        await sprPage.goto(`file://${PROJECT_ROOT}/sprite-maker.html`, { waitUntil: 'domcontentloaded' });
        await sprPage.waitForFunction(() => typeof newSprite !== 'undefined' && typeof serializeSprite !== 'undefined');

        await sprPage.evaluate(async () => {
            newSprite();
            currentSprite.sprite.push({
                imageData: [new Uint8Array(63)],
                spriteName: '-JETL ', xPosition: 0, yPosition: 0,
                isMultiColor: true, xDouble: false, yDouble: false,
                totalFrames: 1, numFrames: 1, numSprites: 2,
                _bgColor: 0, _gmColor1: 2, _gmColor2: 6, _gmColor3: 7
            });
            currentSprite.sprite[0].numSprites = 2;
            currentSprite.sprite[0].spriteName = 'JETL  ';
            pixelData[0][0] = 2;
            syncToSprite();
            await disk.saveFile('JETL  /SPR', serializeSprite());
        });
        await sprPage.close();

        // Now open the editor against the same shared disk
        const edPage = await browser.newPage();
        edPage.on('pageerror', err => console.error('editor page err:', err.message));
        await edPage.goto(EDITOR_URL, { waitUntil: 'domcontentloaded' });
        await edPage.waitForFunction(() => typeof currentProgramData !== 'undefined' && typeof gmDisk !== 'undefined');

        const reloadedNames = await edPage.evaluate(() => {
            currentProgramData = { instructions: [], mediaStore: [null] };
            currentFileData = null;

            const mediaIdx = findOrAddToMediaStore('JETL  /SPR', 'jetl', 'spriteName');
            currentProgramData.instructions.push({
                opcode: 0x27, arg1: 0, arg2: mediaIdx, label: 0,
                instructionName: 'sprite 1 is jetl'
            });
            handleMultiQuadSprite(currentProgramData.instructions[0], mediaIdx, 0);

            saveToDisk('MYTEST/PRG');
            const savedBytes = gmDisk.loadFile('MYTEST/PRG');
            const reloaded = parseProgramData(savedBytes);
            return {
                main: reloaded.mediaStore[1]?.name,
                marker: reloaded.mediaStore[2]?.name
            };
        });

        // Names are stored 6-char-padded throughout the system (parser
        // invariant — see gmParser.js). 'jetl' becomes 'jetl  ', '-jetl'
        // becomes '-jetl '.
        expect(reloadedNames.main).toBe('jetl  ');
        expect(reloadedNames.marker).toBe('-jetl ');
        await edPage.close();
    });

    test('re-picking a sprite whose old (mangled) main is at a non-end index still produces consecutive marker indices', async () => {
        // Reproduces the "Save error: instruction references mediaStore[N] but
        // no entry exists" crash. Scenario: the loaded program has a sprite
        // entry whose name decoded to unprintable chars (so name-based lookup
        // can't match the disk file). User re-picks the same sprite from disk
        // → findOrAddToMediaStore pushes a NEW main at the end of mediaStore.
        // The OLD markers still sit at their original adjacent indices with
        // their original (decodable) name. findSubSpriteInMediaStore used to
        // find them by name and reuse them — but they're NOT adjacent to the
        // new main, so the serializer (which assumes markers are at mainIdx+1)
        // hit a hole and threw.
        const page = await openEditorWithProgram();
        const result = await page.evaluate(() => {
            const fakeSprite = (n) => ({ sprite: new Array(n).fill({}) });
            // Mangled main + correctly-named markers at consecutive old indices
            currentProgramData.mediaStore = [null,
                { name: '??????', type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 },
                { name: '-JETL ', type: 'sprite', sprite: null, spriteFileData: null, quadIndex: 1 },
                // Simulate a freshly-loaded JETL added at the END
                { name: 'JETL  ', type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 }
            ];
            const SPRITE_IS_OP = 0x27;
            currentProgramData.instructions = [
                { opcode: SPRITE_IS_OP, arg1: 1, arg2: 1, label: 0, instructionName: 'sprite 1 is ??????' },
                { opcode: SPRITE_IS_OP, arg1: 2, arg2: 2, label: 0, instructionName: 'sprite 2 is -jetl' }
            ];

            // Simulate the re-pick: arg2 rewritten to the new main's index, then the helper runs.
            const newMainIdx = 3;
            currentProgramData.instructions[0].arg2 = newMainIdx;
            handleMultiQuadSprite(currentProgramData.instructions[0], newMainIdx, 0);

            const markerInstr = currentProgramData.instructions[1];
            return {
                markerArg2: markerInstr.arg2,
                markerSits: currentProgramData.mediaStore[markerInstr.arg2]?.quadIndex,
                isAdjacentToNewMain: markerInstr.arg2 === newMainIdx + 1,
                mediaStoreLen: currentProgramData.mediaStore.length
            };
        });

        // The fresh marker must live at newMainIdx + 1 (whatever new index the
        // helper picked) — not be the leftover orphan from the old (mangled) main.
        expect(result.isAdjacentToNewMain).toBe(true);
        expect(result.markerSits).toBe(1);
        await page.close();
    });

    test('swapping multi-quad → single-quad deletes the orphaned marker lines', async () => {
        const page = await openEditorWithProgram();
        const instrs = await page.evaluate(() => {
            const fakeSprite = (n) => ({ sprite: new Array(n).fill({}) });
            currentProgramData.mediaStore = [null,
                { name: 'FOO',   type: 'sprite', sprite: fakeSprite(2), spriteFileData: new Uint8Array(8), quadIndex: 0 },
                { name: '-FOO',  type: 'sprite', sprite: null, spriteFileData: null, quadIndex: 1 },
                { name: 'ARCH',  type: 'sprite', sprite: fakeSprite(1), spriteFileData: new Uint8Array(8), quadIndex: 0 }
            ];
            const SPRITE_IS_OP = 0x27;
            currentProgramData.instructions = [
                { opcode: SPRITE_IS_OP, arg1: 1, arg2: 1, label: 0, instructionName: 'sprite 1 is foo' },
                { opcode: SPRITE_IS_OP, arg1: 2, arg2: 2, label: 0, instructionName: 'sprite 2 is -foo' }
            ];
            currentProgramData.instructions[0].arg2 = 3;
            handleMultiQuadSprite(currentProgramData.instructions[0], 3, 0);
            return currentProgramData.instructions.map(i => ({
                arg1: i.arg1, arg2: i.arg2,
                targetName: currentProgramData.mediaStore[i.arg2]?.name
            }));
        });

        expect(instrs).toHaveLength(1);                  // The marker line is gone
        expect(instrs[0].targetName).toBe('ARCH');
        await page.close();
    });
});

describe('editor — edit mode (cut/copy/paste/delete)', () => {
    test('entering edit mode swaps the bottom four buttons to ok/cut/copy/paste; ok restores', async () => {
        const page = await openEditorWithProgram();

        const state = await page.evaluate(() => {
            const before = Array.from(document.querySelectorAll('#buttonColumn button'))
                .slice(-4).map(b => b.textContent.trim());
            enterEditMode();
            const inEdit = Array.from(document.querySelectorAll('#buttonColumn button'))
                .slice(-4).map(b => b.textContent.trim());
            exitEditMode();
            const after = Array.from(document.querySelectorAll('#buttonColumn button'))
                .slice(-4).map(b => b.textContent.trim());
            return { before, inEdit, after };
        });

        expect(state.inEdit).toEqual(['ok', 'cut', 'copy', 'paste']);
        // After ok, the bottom 4 are back to what they were
        expect(state.after).toEqual(state.before);
    });

    test('copy + paste duplicates selected lines at the cursor', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            const originalLen = currentProgramData.instructions.length;
            // Select lines 5, 6, 7
            selectedLines = new Set([5, 6, 7]);
            selectedLineIndex = 5;
            const sources = [5,6,7].map(i => currentProgramData.instructions[i].instructionName);

            copySelection();

            // Move cursor to line 20 and paste
            selectedLines.clear();
            selectedLineIndex = 20;
            pasteSelection();

            const afterLen = currentProgramData.instructions.length;
            const pasted = [20, 21, 22].map(i => currentProgramData.instructions[i].instructionName);

            return { originalLen, afterLen, sources, pasted };
        });

        expect(result.afterLen).toBe(result.originalLen + 3);
        expect(result.pasted).toEqual(result.sources);
    });

    test('cut copies AND removes the selection', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            const originalLen = currentProgramData.instructions.length;
            selectedLines = new Set([10, 11]);
            selectedLineIndex = 10;
            const sourceNames = [10, 11].map(i => currentProgramData.instructions[i].instructionName);

            cutSelection();

            return {
                originalLen,
                afterLen: currentProgramData.instructions.length,
                clipboardLen: clipboard.length,
                clipboardNames: clipboard.map(c => c.instructionName),
                sourceNames
            };
        });

        expect(result.afterLen).toBe(result.originalLen - 2);
        expect(result.clipboardLen).toBe(2);
        expect(result.clipboardNames).toEqual(result.sourceNames);
    });

    test('pasted lines get their labels stripped (so paste does not duplicate label numbers)', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            // Find a labeled line, select + copy + paste elsewhere
            const labeledIdx = currentProgramData.instructions.findIndex(i => i.label > 0);
            selectedLines = new Set([labeledIdx]);
            selectedLineIndex = labeledIdx;
            const originalLabel = currentProgramData.instructions[labeledIdx].label;

            copySelection();
            selectedLineIndex = labeledIdx + 5;
            pasteSelection();

            return {
                originalLabel,
                originalStill: currentProgramData.instructions[labeledIdx].label,
                pastedLabel: currentProgramData.instructions[labeledIdx + 5].label
            };
        });

        expect(result.originalLabel).toBeGreaterThan(0);
        expect(result.originalStill).toBe(result.originalLabel);  // original unchanged
        expect(result.pastedLabel).toBe(0);                       // pasted has no label
    });

    test('drag from line 3 to line 7 selects the range [3..7]', async () => {
        const page = await openEditorWithProgram();

        const selected = await page.evaluate(() => {
            const lines = document.querySelectorAll('.program-line');
            const startLine = lines[3];
            const endLine = lines[7];

            // Synthesise mousedown on line 3, mousemove anywhere inside line 7,
            // mouseup. The drag-select threshold is the line's bounds, so any
            // cursor position within line 7's box should include it.
            startLine.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            const endRect = endLine.getBoundingClientRect();
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                clientX: endRect.left + 5,
                clientY: endRect.top + endRect.height / 2
            }));
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

            return [...selectedLines].sort((a, b) => a - b);
        });

        expect(selected).toEqual([3, 4, 5, 6, 7]);
    });
});

describe('editor — typing into a display-offset field maps to the right storage value', () => {
    // Regression: typing "1" into a `sprite` slot field (formatter does +1)
    // wrote storage 1, which displays as "2". User had no way to type slot 1
    // except via arrow keys. _typedToStorage now subtracts the formatter's
    // base display so typed = displayed.
    test('typing "1" into a sprite slot field stores 0 and displays "1"', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            // Find any "sprite N is ..." instruction (opcode 0x27 with sprite arg)
            const idx = currentProgramData.instructions.findIndex(i => i.opcode === 0x27);
            // Select the line and find its `sprite` field
            selectLine(idx);
            const field = document.querySelector(
                `.program-line[data-index="${idx}"] .editable-field[data-type="sprite"]`
            );
            field.classList.add('selected');
            selectedField = field;
            fieldInputBuffer = '';

            // Synthesise the "1" keypress through handleSelectedFieldKey
            handleSelectedFieldKey({
                key: '1',
                preventDefault: () => {},
                stopPropagation: () => {}
            });

            return {
                arg1: currentProgramData.instructions[idx].arg1,
                fieldText: field.textContent
            };
        });

        expect(result.arg1).toBe(0);          // storage
        expect(result.fieldText).toBe('1');   // display
        await page.close();
    });

    test('typing "8" into a sprite slot field stores 7 (max) and displays "8"', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            const idx = currentProgramData.instructions.findIndex(i => i.opcode === 0x27);
            selectLine(idx);
            const field = document.querySelector(
                `.program-line[data-index="${idx}"] .editable-field[data-type="sprite"]`
            );
            field.classList.add('selected');
            selectedField = field;
            fieldInputBuffer = '';

            handleSelectedFieldKey({ key: '8', preventDefault: () => {}, stopPropagation: () => {} });

            return {
                arg1: currentProgramData.instructions[idx].arg1,
                fieldText: field.textContent
            };
        });

        expect(result.arg1).toBe(7);
        expect(result.fieldText).toBe('8');
        await page.close();
    });
});

describe('editor — arg-edit digit input (post-insert / Tab-walk path)', () => {
    // The arg-edit path (handleArgEditKey) and the click-then-type path
    // (handleSelectedFieldKey) both turn typed digits into storage values.
    // They now share _typedToStorage / _maxTypedDisplay so behavior is
    // identical across paths. These tests exercise handleArgEditKey to
    // ensure both paths stay in sync.
    //
    // The harness inserts an instruction, then synthesises keypresses
    // through handleArgEditKey directly (the same entry point onEditorKeyDown
    // uses while argEditMode is active).

    // Drives handleArgEditKey for each character in `keys`, returning the
    // resulting stored arg + the formatted display.
    async function typeIntoNewInstruction(page, opcode, keys, { argIndex = 0 } = {}) {
        return page.evaluate(({ opcode, keys, argIndex }) => {
            placeInstructionAtCursor(opcode);
            // placeInstructionAtCursor calls enterArgEditMode for arg-bearing
            // ops; argEditMode is now true and argEditArgNum lands on the
            // first editable arg slot. Move to the requested arg if not the
            // first via Tab.
            for (let i = 0; i < argIndex; i++) {
                handleArgEditKey({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
            }
            for (const k of keys) {
                handleArgEditKey({ key: k, preventDefault: () => {}, stopPropagation: () => {} });
            }
            const instr = currentProgramData.instructions[argEditLineIndex];
            const opDef = gmOpcodes[instr.opcode];
            const argType = opDef.args[argEditArgNum - 1];
            const stored = argEditArgNum === 1 ? instr.arg1 : instr.arg2;
            // formatFieldValue is what the listing's field shows.
            const display = formatFieldValue(argType, stored, instr);
            return { stored, display };
        }, { opcode, keys, argIndex });
    }

    // Sprite arg: 0x27 = "sprite N is name". Arg0 is the sprite slot.
    test('sprite slot — typing "1" stores 0 / displays "1"', async () => {
        const page = await openEditorWithProgram();
        const r = await typeIntoNewInstruction(page, 0x27, ['1']);
        expect(r.stored).toBe(0);
        expect(r.display).toBe('1');
        await page.close();
    });

    test('sprite slot — typing "2" twice stores 1 / displays "2" (overflow resets the buffer)', async () => {
        const page = await openEditorWithProgram();
        const r = await typeIntoNewInstruction(page, 0x27, ['2', '2']);
        expect(r.stored).toBe(1);
        expect(r.display).toBe('2');
        await page.close();
    });

    test('sprite slot — typing "8" stores 7 (max) / displays "8"', async () => {
        const page = await openEditorWithProgram();
        const r = await typeIntoNewInstruction(page, 0x27, ['8']);
        expect(r.stored).toBe(7);
        expect(r.display).toBe('8');
        await page.close();
    });

    // Sprite movement speed: 0x26 is "sprite N speed=[a]" — uses a `var` arg.
    // 0x25 is "sprite N speed=000" — uses `num` arg (0-255 display=storage).
    test('num field (sprite speed) — multi-digit "1","2","3" stores 123', async () => {
        const page = await openEditorWithProgram();
        const r = await typeIntoNewInstruction(page, 0x25, ['1', '2', '3'], { argIndex: 1 });
        expect(r.stored).toBe(123);
        expect(r.display).toBe('123');
        await page.close();
    });

    // var fields accept letters only. Digits used to leak into the
    // numeric-digit branch and write the raw 1-26 storage value, so
    // typing "12" stored 12 → display "l". Each type now owns its
    // accepted input modes and explicitly ignores everything else.
    test('var field — digit input is ignored (no leak into numeric branch)', async () => {
        const page = await openEditorWithProgram();
        // 0x07 = "set a = [a]" → args=['var', 'var']
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x07);
            const before = currentProgramData.instructions[argEditLineIndex].arg1;
            // Default for var is 1 ("a"). Type "1" "2" — both digits should
            // be no-ops on a var field.
            handleArgEditKey({ key: '1', preventDefault: () => {}, stopPropagation: () => {} });
            handleArgEditKey({ key: '2', preventDefault: () => {}, stopPropagation: () => {} });
            const after = currentProgramData.instructions[argEditLineIndex].arg1;
            return { before, after };
        });
        expect(r.before).toBe(1);   // default 'a'
        expect(r.after).toBe(1);    // unchanged — digits ignored
        await page.close();
    });

    test('var field — letters move the value (a-z → 1-26)', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x07);
            handleArgEditKey({ key: 'g', preventDefault: () => {}, stopPropagation: () => {} });
            const instr = currentProgramData.instructions[argEditLineIndex];
            return { stored: instr.arg1, display: formatFieldValue('var', instr.arg1, instr) };
        });
        expect(r.stored).toBe(7);    // 'g' = 7th letter
        expect(r.display).toBe('g');
        await page.close();
    });

    // Regression: opcodes with args=['unused', X] used to start arg-edit
    // on the 'unused' slot (argEditArgIndex=0), so typing wrote to arg1
    // while the actual editable field was arg2. Refactored to identify
    // the active arg by storage slot number (matches the DOM data-arg-num
    // that dragging already uses), with 'unused' slots skipped.
    // 0x01 = "jump to label l001" → args=['unused', 'label']; arg0 is unused,
    // typing should land in arg2 (the label).
    test('jump-to-label — typing "5" stores 5 in arg2 (skips the "unused" arg slot)', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x01);
            // No Tab needed — enterArgEditMode skips 'unused' and starts on label.
            handleArgEditKey({ key: '5', preventDefault: () => {}, stopPropagation: () => {} });
            const instr = currentProgramData.instructions[argEditLineIndex];
            return { arg1: instr.arg1, arg2: instr.arg2, argNum: argEditArgNum };
        });
        expect(r.argNum).toBe(2);     // started on the label slot, not 'unused'
        expect(r.arg1).toBe(0);       // unused untouched
        expect(r.arg2).toBe(5);       // label takes the typed digit
        await page.close();
    });

    test('num field — overflow ("3","0","0") resets buffer past 255', async () => {
        const page = await openEditorWithProgram();
        // 300 > 255, so the buffer resets to "0" on the third digit.
        const r = await typeIntoNewInstruction(page, 0x25, ['3', '0', '0'], { argIndex: 1 });
        expect(r.stored).toBe(0);
        await page.close();
    });

    // Score-value arg: 0x58 = "add [a] to score[a]" uses `var` args. The
    // typed-score-add instruction is 0x57 — "add 000 to score[a]" with
    // arg0 = scoreValue (display * 10). Verify via opcode lookup.
    test('scoreValue — typing "1" stores 1 / displays "0010"', async () => {
        const page = await openEditorWithProgram();
        // Find the opcode whose first arg is `scoreValue`.
        const opcode = await page.evaluate(() => {
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args[0] === 'scoreValue') return parseInt(k);
            }
            return null;
        });
        expect(opcode).not.toBeNull();
        const r = await typeIntoNewInstruction(page, opcode, ['1']);
        expect(r.stored).toBe(1);
        expect(r.display).toBe('0010');
        await page.close();
    });

    test('scoreValue — typing "1","0","0" stores 100 / displays "1000"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await page.evaluate(() => {
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args[0] === 'scoreValue') return parseInt(k);
            }
            return null;
        });
        const r = await typeIntoNewInstruction(page, opcode, ['1', '0', '0']);
        expect(r.stored).toBe(100);
        expect(r.display).toBe('1000');
        await page.close();
    });

    test('scoreValue — typing "1","0","0","0" stores 100 (display "1000" = max)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await page.evaluate(() => {
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args[0] === 'scoreValue') return parseInt(k);
            }
            return null;
        });
        // 4th "0" gives tentative 1000 which equals the display max — kept.
        // Internal clamps to 100 → display "1000".
        const r = await typeIntoNewInstruction(page, opcode, ['1', '0', '0', '0']);
        expect(r.stored).toBe(100);
        expect(r.display).toBe('1000');
        await page.close();
    });

    test('scoreValue — typing a fifth "0" overflows past 1000 and resets the buffer', async () => {
        const page = await openEditorWithProgram();
        const opcode = await page.evaluate(() => {
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args[0] === 'scoreValue') return parseInt(k);
            }
            return null;
        });
        // After 4 keys we're at "1000". 5th "0" → tentative "10000" > 1000 →
        // buffer resets to just "0" → stored 0, display "0000".
        const r = await typeIntoNewInstruction(page, opcode, ['1', '0', '0', '0', '0']);
        expect(r.stored).toBe(0);
        expect(r.display).toBe('0000');
        await page.close();
    });

    // Enum-typed input: single keystroke, no buffer/timeout. Letter keys
    // match by display.startsWith, digit keys by display.includes (so "1"
    // finds "scene1" embedded in the word). Repeating the same key cycles
    // through matches with wrap.
    async function findOpcodeWithArg(page, argType, argIndex = 1) {
        return page.evaluate(({ argType, argIndex }) => {
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args[argIndex] === argType) return parseInt(k);
            }
            return null;
        }, { argType, argIndex });
    }

    test('alwaysOnce — typing "o" selects "once" (unique match)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'alwaysOnce', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['o'], { argIndex: 1 });
        expect(r.stored).toBe(1);
        expect(r.display).toBe('once');
        await page.close();
    });

    test('alwaysOnce — typing "o" then "a" pops back to "always" (no buffer)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'alwaysOnce', 1);
        // The earlier behavior treated "o" + "a" as a search buffer "oa"
        // (no match → stuck on "once"); now each keystroke is final.
        const r = await typeIntoNewInstruction(page, opcode, ['o', 'a'], { argIndex: 1 });
        expect(r.stored).toBe(0);
        expect(r.display).toBe('always');
        await page.close();
    });

    test('onOff — repeated "o" cycles on → off → on (both start with "o")', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'onOff', 1);
        // Default value is 0 ("on"). Each 'o' cycles to the other.
        const after1 = await typeIntoNewInstruction(page, opcode, ['o'], { argIndex: 1 });
        expect(after1.display).toBe('off');         // 0 → 1
        const after2 = await typeIntoNewInstruction(page, opcode, ['o', 'o'], { argIndex: 1 });
        expect(after2.display).toBe('on');          // 0 → 1 → 0
        const after3 = await typeIntoNewInstruction(page, opcode, ['o', 'o', 'o'], { argIndex: 1 });
        expect(after3.display).toBe('off');         // 0 → 1 → 0 → 1
        await page.close();
    });

    test('sceneTarget — typing "1" jumps straight to "scene1" (digit-in-word match)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'sceneTarget', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['1'], { argIndex: 1 });
        expect(r.stored).toBe(0);
        expect(r.display).toBe('scene1');
        await page.close();
    });

    test('sceneTarget — typing "2" jumps to "scene2"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'sceneTarget', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['2'], { argIndex: 1 });
        expect(r.stored).toBe(1);
        expect(r.display).toBe('scene2');
        await page.close();
    });

    test('sceneTarget — typing "b" selects "both"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'sceneTarget', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['b'], { argIndex: 1 });
        expect(r.stored).toBe(2);
        expect(r.display).toBe('both');
        await page.close();
    });

    // hitTarget regression check: my earlier OFFSET_PLUS_ONE_TYPES refactor
    // accidentally broke hitTarget digit input (formatter returns "sprite 1"
    // for value 0; parseInt-from-start gave NaN). _extractDisplayNumber
    // pulls the first digit run, so the offset is recovered.
    test('hitTarget — typing "5" jumps to "sprite 5" (digit-in-word match)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'hitTarget', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['5'], { argIndex: 1 });
        expect(r.stored).toBe(4);
        expect(r.display).toBe('sprite 5');
        await page.close();
    });

    test('hitTarget — typing "a" selects "anyone" (the non-sprite option)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'hitTarget', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['a'], { argIndex: 1 });
        expect(r.stored).toBe(8);
        expect(r.display).toBe('anyone');
        await page.close();
    });

    // seconds: storage × 0.1 = displayed seconds. The fix was twofold:
    //   1) The whole part is zero-padded ("00.1", "01.0", "10.0", "25.5")
    //      so concatenating all digits in the display gives the storage
    //      value: "100" → 100 storage → "10.0".
    //   2) Range min = 1 (no 0.0 / no-pause). Default = 1 on insert.
    test('seconds — typing "100" stores 100 / displays "10.0"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'seconds', 1);
        // seconds opcode is args=['unused', 'seconds'] — enterArgEditMode
        // auto-skips 'unused', so we don't pre-Tab. argIndex: 0 means
        // "type into whatever slot we land on after insert".
        const r = await typeIntoNewInstruction(page, opcode, ['1', '0', '0'], { argIndex: 0 });
        expect(r.stored).toBe(100);
        expect(r.display).toBe('10.0');
        await page.close();
    });

    test('seconds — typing "255" stores 255 / displays "25.5" (max)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'seconds', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['2', '5', '5'], { argIndex: 0 });
        expect(r.stored).toBe(255);
        expect(r.display).toBe('25.5');
        await page.close();
    });

    test('seconds — default value on insert is 1 (display "00.1", not 0.0)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'seconds', 1);
        const r = await page.evaluate((opcode) => {
            placeInstructionAtCursor(opcode);
            const instr = currentProgramData.instructions[argEditLineIndex];
            const opDef = gmOpcodes[opcode];
            const slot = opDef.args.indexOf('seconds') + 1;
            const stored = slot === 1 ? instr.arg1 : instr.arg2;
            return { stored, display: formatFieldValue('seconds', stored, instr) };
        }, opcode);
        expect(r.stored).toBe(1);
        expect(r.display).toBe('00.1');
        await page.close();
    });

    // direction: letters jump to the cardinal byte (u/d/l/r → 0/128/192/64),
    // digits address the raw byte directly (0-255). Cardinal byte values
    // show a label in the display ("up 000  000°", "down 128  180°", etc.).
    test('direction — typing "u" sets byte to 0, display "000  up"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['u'], { argIndex: 1 });
        expect(r.stored).toBe(0);
        expect(r.display).toBe('000  up');
        await page.close();
    });

    test('direction — typing "d" sets byte to 128, display "128  down"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['d'], { argIndex: 1 });
        expect(r.stored).toBe(128);
        expect(r.display).toBe('128  down');
        await page.close();
    });

    test('direction — typing "l" sets byte to 192, display "192  left"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['l'], { argIndex: 1 });
        expect(r.stored).toBe(192);
        expect(r.display).toBe('192  left');
        await page.close();
    });

    test('direction — typing "r" sets byte to 64, display "064  right"', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['r'], { argIndex: 1 });
        expect(r.stored).toBe(64);
        expect(r.display).toBe('064  right');
        await page.close();
    });

    test('direction — typing "100" sets raw byte to 100 (numeric path, not cycle)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['1', '0', '0'], { argIndex: 1 });
        expect(r.stored).toBe(100);
        // Non-cardinal byte → standard "${byte}  ${deg}°" display.
        expect(r.display).toBe('100  141°');
        await page.close();
    });

    // Regression: enum-cycle keystrokes (e.g. typing "r" on direction)
    // weren't resetting the digit accumulator. So "r" then "1" would
    // append "1" to whatever was in argEditValue from earlier digit
    // input, producing surprising clamps. After the fix, "r" then "1"
    // is equivalent to a fresh "1".
    test('direction — "r" then "1" resets the digit buffer (1 → byte 1, not 641)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        // Type some digits first to dirty the buffer, then enum-cycle, then digit.
        const r = await typeIntoNewInstruction(page, opcode, ['6', '4', 'r', '1'], { argIndex: 1 });
        expect(r.stored).toBe(1);
        expect(r.display).toBe('001  001°');
        await page.close();
    });

    // Regression: at the typed max ("255"), the buffer used to keep
    // growing for several keystrokes before exceeding the display-derived
    // cap (255357 for direction). Capping at range.max means typing "1"
    // at 255 immediately resets to "001".
    test('direction — at byte 255, typing "1" resets to byte 1 (not stuck at 255)', async () => {
        const page = await openEditorWithProgram();
        const opcode = await findOpcodeWithArg(page, 'direction', 1);
        const r = await typeIntoNewInstruction(page, opcode, ['2', '5', '5', '1'], { argIndex: 1 });
        expect(r.stored).toBe(1);
        expect(r.display).toBe('001  001°');
        await page.close();
    });
});

describe('editor — arg-edit arrow stepping', () => {
    // Arrows step the field's value by ±1 and clamp at the type's
    // min/max (no wraparound — that felt disorienting in practice).
    // Tests cover sprite (numeric with display offset), num (plain
    // 0-255), and alwaysOnce (enum with only 2 values) to exercise
    // each formatter path through _nextFieldValue.

    test('sprite slot — ArrowUp steps 0→1→2, ArrowDown reverses', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x27);  // sprite N is name
            handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const afterUp1 = currentProgramData.instructions[argEditLineIndex].arg1;
            handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const afterUp2 = currentProgramData.instructions[argEditLineIndex].arg1;
            handleArgEditKey({ key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} });
            const afterDown = currentProgramData.instructions[argEditLineIndex].arg1;
            return { afterUp1, afterUp2, afterDown };
        });
        expect(r.afterUp1).toBe(1);
        expect(r.afterUp2).toBe(2);
        expect(r.afterDown).toBe(1);
        await page.close();
    });

    test('sprite slot — ArrowUp at max (7) clamps; ArrowDown at min (0) clamps', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x27);
            // Walk to max: 8 ups (default 0 + 8 = 7 clamped, last is no-op).
            for (let i = 0; i < 8; i++) handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const atMax = currentProgramData.instructions[argEditLineIndex].arg1;
            handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const stillMax = currentProgramData.instructions[argEditLineIndex].arg1;
            // Walk down to 0 and try one more.
            for (let i = 0; i < 7; i++) handleArgEditKey({ key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} });
            const atMin = currentProgramData.instructions[argEditLineIndex].arg1;
            handleArgEditKey({ key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} });
            const stillMin = currentProgramData.instructions[argEditLineIndex].arg1;
            return { atMax, stillMax, atMin, stillMin };
        });
        expect(r.atMax).toBe(7);
        expect(r.stillMax).toBe(7);   // clamps, doesn't wrap to 0
        expect(r.atMin).toBe(0);
        expect(r.stillMin).toBe(0);   // clamps, doesn't wrap to 7
        await page.close();
    });

    test('enum field (alwaysOnce) — ArrowUp/Down clamps at min and max', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            // Find an alwaysOnce opcode (range 0-1).
            let opcode = null;
            for (const [k, def] of Object.entries(gmOpcodes)) {
                if (def.args && def.args.includes('alwaysOnce')) { opcode = parseInt(k); break; }
            }
            placeInstructionAtCursor(opcode);
            // Tab to the alwaysOnce slot if it's not arg1.
            const opDef = gmOpcodes[opcode];
            const slot = opDef.args.indexOf('alwaysOnce') + 1;
            while (argEditArgNum !== slot) {
                handleArgEditKey({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
            }
            // Default is 0 ('always'). ArrowDown should clamp (no wrap to max).
            handleArgEditKey({ key: 'ArrowDown', preventDefault: () => {}, stopPropagation: () => {} });
            const downAtMin = currentProgramData.instructions[argEditLineIndex][`arg${slot}`];
            handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const upOnce = currentProgramData.instructions[argEditLineIndex][`arg${slot}`];
            handleArgEditKey({ key: 'ArrowUp', preventDefault: () => {}, stopPropagation: () => {} });
            const upAtMax = currentProgramData.instructions[argEditLineIndex][`arg${slot}`];
            return { downAtMin, upOnce, upAtMax };
        });
        expect(r.downAtMin).toBe(0);  // clamp at 0
        expect(r.upOnce).toBe(1);     // step to 1
        expect(r.upAtMax).toBe(1);    // clamp at 1 (no wrap)
        await page.close();
    });
});

describe('editor — arg-edit Tab navigation', () => {
    // Tab walks the editable arg slots in order, skipping any
    // 'unused' slots. At the end of the line Tab hops to the first
    // editable arg of the next line that has one. At the end of the
    // program it exits arg-edit so the user can keep inserting.

    test('Tab on a 2-arg line moves arg1 → arg2, Shift+Tab reverses', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            placeInstructionAtCursor(0x27);  // sprite N is name → args=['sprite', 'spriteName']
            const start = argEditArgNum;
            handleArgEditKey({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
            const afterTab = argEditArgNum;
            handleArgEditKey({ key: 'Tab', shiftKey: true, preventDefault: () => {}, stopPropagation: () => {} });
            const afterShiftTab = argEditArgNum;
            return { start, afterTab, afterShiftTab };
        });
        expect(r.start).toBe(1);
        expect(r.afterTab).toBe(2);
        expect(r.afterShiftTab).toBe(1);
        await page.close();
    });

    test('Tab on a line with args=["unused", X] hops to the next line (no second arg to advance to)', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            // Insert two jump-to-label instructions back to back.
            placeInstructionAtCursor(0x01);  // line N
            handleArgEditKey({ key: 'Enter', preventDefault: () => {}, stopPropagation: () => {} });
            const firstLine = selectedLineIndex - 1;  // exited; cursor advanced
            placeInstructionAtCursor(0x01);  // line N+1
            // We're now editing the label on line N+1 (argEditArgNum=2).
            // Move back to line N by Shift+Tab — should hop, not stay
            // (there's no arg before the label on this line).
            handleArgEditKey({ key: 'Tab', shiftKey: true, preventDefault: () => {}, stopPropagation: () => {} });
            return { firstLine, landedOn: argEditLineIndex, landedArgNum: argEditArgNum };
        });
        expect(r.landedOn).toBe(r.firstLine);
        expect(r.landedArgNum).toBe(2);  // first line's label slot (arg2)
        await page.close();
    });

    test('Tab past the last editable arg in the program exits arg-edit and advances the cursor', async () => {
        const page = await openEditorWithProgram();
        const r = await page.evaluate(() => {
            // Clear program so we have a known tail.
            currentProgramData = { instructions: [], mediaStore: [null] };
            selectedLineIndex = 0;
            renderProgramListing();

            placeInstructionAtCursor(0x27);  // sprite N is name
            // Now editing arg1 (sprite slot). Tab to arg2.
            handleArgEditKey({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
            // Tab again past last editable arg in last line → should exit + advance.
            handleArgEditKey({ key: 'Tab', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {} });
            return { argEditMode, selectedLineIndex };
        });
        expect(r.argEditMode).toBe(false);
        expect(r.selectedLineIndex).toBe(1);  // moved past the inserted line
        await page.close();
    });
});

describe('editor — arg-edit drag (cycle on vertical drag, then keyboard takes over)', () => {
    // onFieldMouseDown starts a drag, onFieldMouseMove cycles the
    // value, onFieldMouseUp transitions to keyboard-input mode. The
    // drag direction is "up = increase" (delta = startY - currentY).

    // Helper: insert a fresh instruction, exit arg-edit, then align
    // selectedLineIndex with the inserted line so the click-selects-line
    // logic in onFieldMouseDown doesn't re-render and invalidate our
    // captured field reference.
    async function freshFieldForDrag(page, opcode, argNum = 1) {
        return page.evaluate(({ opcode, argNum }) => {
            placeInstructionAtCursor(opcode);
            exitArgEditMode();
            const lineIdx = currentProgramData.instructions.length - 1;
            selectedLineIndex = lineIdx;
            selectedLines.clear();
            selectedLines.add(lineIdx);
            renderProgramListing();
            const field = document.querySelector(
                `.program-line[data-index="${lineIdx}"] .editable-field[data-arg-num="${argNum}"]`
            );
            // Stash for subsequent calls.
            window._dragLineIdx = lineIdx;
            window._dragField = field;
            return lineIdx;
        }, { opcode, argNum });
    }

    // These tests dispatch real PointerEvents on the field span. The
    // arg-field drag was converted from document-level mouse events to
    // element-level pointer events (with setPointerCapture) so touch
    // drag works on mobile. Same pattern is used in sprite-maker,
    // scene-maker, sound-maker, music-maker.

    test('drag-up on a sprite slot field bumps the value up by the drag distance', async () => {
        const page = await openEditorWithProgram();
        await freshFieldForDrag(page, 0x27, 1);  // sprite N is name
        const result = await page.evaluate(() => {
            const field = window._dragField;
            const lineIdx = window._dragLineIdx;
            // Fire pointerdown on the field span — kicks the handler into
            // drag mode and attaches pointermove/pointerup listeners on
            // the span itself.
            field.dispatchEvent(new PointerEvent('pointerdown', {
                pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientY: 500,
            }));
            const afterDown = currentProgramData.instructions[lineIdx].arg1;
            const isActive = field.classList.contains('active');

            // Drag up by 15px. Sensitivity for an 8-value field is
            // `max(1, min(10, floor(200/8)))` = 10 px/step (the cap
            // kicks in). 15/10 = 1 step, so value bumps by 1.
            field.dispatchEvent(new PointerEvent('pointermove', {
                pointerId: 1, isPrimary: true, bubbles: true, clientY: 485,
            }));
            const afterMove = currentProgramData.instructions[lineIdx].arg1;

            // Release — should transition to .selected.
            field.dispatchEvent(new PointerEvent('pointerup', {
                pointerId: 1, isPrimary: true, bubbles: true,
            }));
            const isSelected = field.classList.contains('selected');
            const isActiveAfterUp = field.classList.contains('active');

            return { afterDown, isActive, afterMove, isSelected, isActiveAfterUp };
        });
        expect(result.afterDown).toBe(0);     // pointerdown doesn't change value
        expect(result.isActive).toBe(true);   // drag-mode highlight
        expect(result.afterMove).toBe(1);     // dragged up = value increased
        expect(result.isSelected).toBe(true); // pointerup → keyboard-input mode
        expect(result.isActiveAfterUp).toBe(false);
        await page.close();
    });

    test('drag-down on a sprite slot clamps at the min (0)', async () => {
        const page = await openEditorWithProgram();
        await freshFieldForDrag(page, 0x27, 1);
        const result = await page.evaluate(() => {
            const field = window._dragField;
            const lineIdx = window._dragLineIdx;
            // Drag DOWN — Δy = startY - currentY, so positive currentY-deltaY
            // means deltaY is negative → value decreases (and clamps at 0).
            field.dispatchEvent(new PointerEvent('pointerdown', {
                pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientY: 500,
            }));
            field.dispatchEvent(new PointerEvent('pointermove', {
                pointerId: 1, isPrimary: true, bubbles: true, clientY: 600,
            }));
            const afterMove = currentProgramData.instructions[lineIdx].arg1;
            field.dispatchEvent(new PointerEvent('pointerup', {
                pointerId: 1, isPrimary: true, bubbles: true,
            }));
            return { afterMove };
        });
        expect(result.afterMove).toBe(0);  // already at min, clamped
        await page.close();
    });
});

describe('editor — find command', () => {
    test('typing in the find input highlights matching lines, count updates, and < > cycles', async () => {
        const page = await openEditorWithProgram();

        // Click the find button to enter find mode (input should appear)
        await page.evaluate(() => findInstruction());
        await page.waitForSelector('#findInput');

        // Type a query that matches many lines in the fixture. GMC64I
        // has many "sprite N is …" instructions so "sprite" hits a lot.
        await page.evaluate(() => {
            const input = document.getElementById('findInput');
            input.value = 'sprite';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const initial = await page.evaluate(() => ({
            matchCount: findMode.matches.length,
            countText: document.getElementById('findCount').textContent,
            currentIndex: findMode.currentIndex,
            highlightedLines: document.querySelectorAll('.program-line.find-match').length,
            currentLines: document.querySelectorAll('.program-line.find-current').length
        }));

        expect(initial.matchCount).toBeGreaterThan(1);
        expect(initial.highlightedLines).toBe(initial.matchCount);
        expect(initial.currentLines).toBe(1);
        expect(initial.countText).toBe(`1/${initial.matchCount}`);

        // Step forward — the current-index increments and the count text changes
        await page.evaluate(() => findStep(1));
        const afterNext = await page.evaluate(() => ({
            currentIndex: findMode.currentIndex,
            countText: document.getElementById('findCount').textContent
        }));
        expect(afterNext.currentIndex).toBe(1);
        expect(afterNext.countText).toBe(`2/${initial.matchCount}`);

        // Step backward TWICE — wraps around to the last match
        await page.evaluate(() => { findStep(-1); findStep(-1); });
        const wrapped = await page.evaluate(() => findMode.currentIndex);
        expect(wrapped).toBe(initial.matchCount - 1);

        await page.close();
    });

    test('exiting find clears the highlights and the message area', async () => {
        const page = await openEditorWithProgram();

        await page.evaluate(() => {
            findInstruction();
            document.getElementById('findInput').value = 'sprite';
            document.getElementById('findInput').dispatchEvent(new Event('input', { bubbles: true }));
        });
        // Sanity: there are highlights
        const before = await page.$$eval('.program-line.find-match', els => els.length);
        expect(before).toBeGreaterThan(0);

        await page.evaluate(() => exitFindMode());
        const state = await page.evaluate(() => ({
            highlights: document.querySelectorAll('.program-line.find-match').length,
            messageContent: document.getElementById('statusMessage').textContent,
            modeActive: findMode.active
        }));
        expect(state.highlights).toBe(0);
        expect(state.messageContent).toBe('');
        expect(state.modeActive).toBe(false);
        await page.close();
    });

    test('Tab in the find input advances to the next match (Shift+Tab = previous)', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            findInstruction();
            const input = document.getElementById('findInput');
            input.value = 'sprite';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const beforeIdx = findMode.currentIndex;
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            const afterTab = findMode.currentIndex;
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
            const afterShiftTab = findMode.currentIndex;
            return { beforeIdx, afterTab, afterShiftTab };
        });

        expect(result.beforeIdx).toBe(0);
        expect(result.afterTab).toBe(1);
        expect(result.afterShiftTab).toBe(0);
        await page.close();
    });

    test('Cmd/Ctrl-F opens find mode (overrides the browser native find)', async () => {
        const page = await openEditorWithProgram();

        // Dispatch a synthetic Cmd-F at the window
        const opened = await page.evaluate(() => {
            const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true });
            window.dispatchEvent(event);
            return {
                modeActive: findMode.active,
                inputFocused: document.activeElement && document.activeElement.id === 'findInput'
            };
        });

        expect(opened.modeActive).toBe(true);
        expect(opened.inputFocused).toBe(true);
        await page.close();
    });

    test('clicking a line while find is active dismisses find', async () => {
        const page = await openEditorWithProgram();

        const result = await page.evaluate(() => {
            findInstruction();
            document.getElementById('findInput').value = 'sprite';
            document.getElementById('findInput').dispatchEvent(new Event('input', { bubbles: true }));
            const beforeActive = findMode.active;
            // Click the first program line
            const line = document.querySelector('.program-line');
            line.click();
            return {
                beforeActive,
                afterActive: findMode.active,
                highlightsAfter: document.querySelectorAll('.program-line.find-match').length
            };
        });

        expect(result.beforeActive).toBe(true);
        expect(result.afterActive).toBe(false);
        expect(result.highlightsAfter).toBe(0);
        await page.close();
    });

    test('search covers labels, comments, instruction names, and numeric values', async () => {
        const page = await openEditorWithProgram();

        const counts = await page.evaluate(() => {
            const probe = (q) => {
                findInstruction();   // toggle off if needed
                if (!findMode.active) findInstruction();
                document.getElementById('findInput').value = q;
                document.getElementById('findInput').dispatchEvent(new Event('input', { bubbles: true }));
                return findMode.matches.length;
            };
            const label   = probe('l001');     // a label that exists in the fixture
            const command = probe('sprite');   // shows in many instructions
            const value   = probe('064');      // appears in direction-value args
            return { label, command, value };
        });

        // Each category should produce some matches in the fixture
        expect(counts.label).toBeGreaterThan(0);
        expect(counts.command).toBeGreaterThan(0);
        expect(counts.value).toBeGreaterThan(0);
        await page.close();
    });
});

// Regression for a session-restore bug that used to lose scenes with
// names shorter than 6 characters. The fix has two parts:
//   1. entry.name is always 6-char-padded throughout the system (parser
//      invariant — see gmParser.js parseProgramData and the comment block
//      there). Tests inject already-padded names to mirror that.
//   2. saveCurrentProgramState builds sceneFileName from entry.name + '/PIC'
//      with no extra processing. The invariant means the filename is
//      automatically the GM-correct form ("STARS /PIC", trailing space
//      significant). This describe pins that behavior so a future "let's
//      trim again" change is loud.
describe('editor — session save records scene filenames with GM-style padding', () => {
    async function probeSavedSceneFilename(page, sceneName) {
        return await page.evaluate((name) => {
            currentProgramData.mediaStore.push({
                name, type: 'scene', scene: null
            });
            saveCurrentProgramState();
            const json = JSON.parse(localStorage.getItem('gm_editedProgram'));
            const entry = json.mediaStore.find(m => m && m.type === 'scene' && m.name === name);
            return entry ? entry.sceneFileName : null;
        }, sceneName);
    }

    test('5-char base padded to 6 produces correct filename', async () => {
        const page = await openEditorWithProgram();
        // Inject as the invariant requires: 6-char-padded name.
        const name = await probeSavedSceneFilename(page, 'STARS ');
        // Trailing space is significant — disk lookup uses this exact string.
        expect(name).toBe('STARS /PIC');
        await page.close();
    });

    test('full-length scene name (6 chars) keeps its shape', async () => {
        const page = await openEditorWithProgram();
        const name = await probeSavedSceneFilename(page, 'MEADOW');
        expect(name).toBe('MEADOW/PIC');
        await page.close();
    });

    test('3-char base padded to 6 produces correct filename', async () => {
        const page = await openEditorWithProgram();
        const name = await probeSavedSceneFilename(page, 'SKY   ');
        expect(name).toBe('SKY   /PIC');
        await page.close();
    });
});
