/**
 * Disk popup interaction tests
 *
 * Drives the shared disk popup (gmDisk + gmTools) through a real headless browser
 * to cover the save row, overwrite prompt, showInfoMessage, and custom buttons.
 * Targets music-maker because it exercises every feature: prefill, saveX(fileName),
 * customButtons (MIDI), and onSave → saveFile.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const MUSIC_MAKER_URL = `file://${join(PROJECT_ROOT, 'music-maker.html')}`;
const STORAGE_KEY = 'gm_disk_music-maker';

let browser;
let blankDiskBase64;
let s2DiskBase64;
let s2Directory;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
    s2DiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
    s2Directory = JSON.parse(readFileSync(join(PROJECT_ROOT, 'tests/golden/testdisk-directory.json'), 'utf8'));
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openPage({ withDisk = true, disk = 'blank' } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    if (withDisk) {
        const data = disk === 's2' ? s2DiskBase64 : blankDiskBase64;
        const name = disk === 's2' ? 'gmc64-test.d64' : 'test.d64';
        await page.evaluateOnNewDocument((data, name, key) => {
            localStorage.clear();
            localStorage.setItem(key, data);
            localStorage.setItem(key + '_name', name);
        }, data, name, STORAGE_KEY);
    } else {
        await page.evaluateOnNewDocument(() => localStorage.clear());
    }

    await page.goto(MUSIC_MAKER_URL, { waitUntil: 'domcontentloaded' });
    // Wait for the page's disk instance to exist
    await page.waitForFunction(() => typeof disk !== 'undefined');
    return page;
}

async function openDiskPopup(page) {
    await page.click('#btnFile');
    await page.waitForSelector('.gm-disk-dialog');
}

describe('disk popup save row', () => {
    test('opens with a name input that is 6-char lowercase', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        const props = await page.evaluate(() => {
            const input = document.querySelector('.gm-disk-name-input');
            const saveBtn = document.querySelector('.gm-disk-save');
            return input ? {
                maxLength: input.maxLength,
                textTransform: getComputedStyle(input).textTransform,
                hasSaveBtn: !!saveBtn
            } : null;
        });

        expect(props).not.toBeNull();
        expect(props.maxLength).toBe(6);
        expect(props.textTransform).toBe('lowercase');
        expect(props.hasSaveBtn).toBe(true);
        await page.close();
    });

    test('input strips invalid chars and clamps to 6 chars lowercase', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        // Real keystrokes so the input event fires
        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'ABC-1.23xyz!@#');

        const value = await page.$eval('.gm-disk-name-input', el => el.value);
        // 'ABC-1.23xyz!@#' → lowercase + strip non-[a-z0-9 ] → 'abc123xyz' → first 6 = 'abc123'
        expect(value).toBe('abc123');
        await page.close();
    });
});

describe('disk popup save behaviour', () => {
    test('save with no disk flashes "Insert a disk first"', async () => {
        const page = await openPage({ withDisk: false });
        await openDiskPopup(page);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');

        const msg = await page.$eval('.gm-disk-info-message', el => ({
            hidden: el.hidden,
            text: el.textContent
        }));
        expect(msg.hidden).toBe(false);
        expect(msg.text).toMatch(/insert a disk/i);
        await page.close();
    });

    test('save with new name writes file, closes the popup, and the file appears on the disk', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');

        // Successful save closes the popup (the "save and continue" UX).
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));

        // File landed on disk
        const files = await page.evaluate(() => disk.disk.getDirectory().map(e => e.fileName));
        expect(files.some(f => /song1/i.test(f))).toBe(true);
        await page.close();
    });

    test('saving with internal whitespace preserves it (e.g. "ab cd" → "ab cd ")', async () => {
        // GM filenames keep middle spaces. The disk popup's save path used to
        // strip them via formatFileName; this test pins the contract for the
        // d64 popup specifically.
        const page = await openPage();
        await openDiskPopup(page);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'ab cd');
        await page.click('.gm-disk-save');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));

        const files = await page.evaluate(() =>
            disk.disk.getDirectory().map(e => e.fileName)
        );
        expect(files).toContain('AB CD /SNG');
        await page.close();
    });

    // Helper: do an initial save (which auto-closes the popup), then reopen
    // for the second-save scenarios below. Each test needs the file on disk
    // already so the second save hits the existing-name path. We clear the
    // input on reopen because suggestedSaveName prefills it with the last
    // saved filename and typing would otherwise append.
    async function saveAndReopen(page, name) {
        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', name);
        await page.click('.gm-disk-save');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        await openDiskPopup(page);
        await page.$eval('.gm-disk-name-input', el => { el.value = ''; });
    }

    test('save with existing name shows overwrite prompt in info bar (popup stays open)', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await saveAndReopen(page, 'song1');

        // Second save with the same name → overwrite prompt, popup stays open
        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');

        const state = await page.evaluate(() => ({
            popupOpen: !!document.querySelector('.gm-disk-dialog'),
            promptHidden: document.querySelector('.gm-disk-overwrite-prompt').hidden,
            promptText: document.querySelector('.gm-disk-overwrite-prompt').textContent.trim()
        }));
        expect(state.popupOpen).toBe(true);
        expect(state.promptHidden).toBe(false);
        expect(state.promptText).toMatch(/overwrite\?.*yes.*no/i);
        await page.close();
    });

    test('overwrite "no" cancels save and leaves the popup open', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await saveAndReopen(page, 'song1');
        const countBefore = await page.$$eval('.gm-disk-files tr[data-index]', rows => rows.length);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');
        await page.click('.gm-disk-overwrite-no');

        const countAfter = await page.$$eval('.gm-disk-files tr[data-index]', rows => rows.length);
        const state = await page.evaluate(() => ({
            popupOpen: !!document.querySelector('.gm-disk-dialog'),
            promptHidden: document.querySelector('.gm-disk-overwrite-prompt').hidden
        }));

        expect(countAfter).toBe(countBefore);   // No new file
        expect(state.popupOpen).toBe(true);     // Cancel keeps popup open
        expect(state.promptHidden).toBe(true);  // Prompt cleared
        await page.close();
    });

    test('overwrite "yes" proceeds AND closes the popup', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await saveAndReopen(page, 'song1');

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');
        await page.click('.gm-disk-overwrite-yes');

        // Confirming the overwrite is a successful save → popup auto-closes.
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        await page.close();
    });
});

describe('disk popup prefill', () => {
    test('reopening the popup after loading a file prefills the input with that name', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        // Load MINUTE/SNG by double-clicking its row — popup closes
        await page.evaluate(() => {
            const rows = document.querySelectorAll('.gm-disk-files tr[data-index]');
            for (const row of rows) {
                if (row.dataset.fileName === 'MINUTE/SNG') {
                    row.click();  // sets the selection (browsers fire click before dblclick)
                    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                    return;
                }
            }
        });
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));

        // Reopen the popup — input should be prefilled
        await openDiskPopup(page);
        const value = await page.$eval('.gm-disk-name-input', el => el.value);
        expect(value).toBe('minute');
        await page.close();
    });

    test('single-clicking a file row prefills the save name (without loading)', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const state = await page.evaluate(() => {
            const rows = document.querySelectorAll('.gm-disk-files tr[data-index]');
            for (const row of rows) {
                if (row.dataset.fileName === 'MINUTE/SNG') {
                    row.click();
                    break;
                }
            }
            return {
                popupOpen: !!document.querySelector('.gm-disk-dialog'),
                inputValue: document.querySelector('.gm-disk-name-input').value,
                rowSelected: document.querySelector('.gm-disk-files tr.selected') !== null
            };
        });

        expect(state.popupOpen).toBe(true);        // Single click does NOT load
        expect(state.inputValue).toBe('minute');   // Save name prefilled
        expect(state.rowSelected).toBe(true);      // Row visually selected
        await page.close();
    });
});

describe('disk popup directory listing', () => {
    test('file list rows match golden directory filtered to /SNG', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const rendered = await page.$$eval('.gm-disk-files tr[data-index]', rows =>
            rows.map(r => {
                const tds = r.querySelectorAll('td');
                return {
                    fileName: r.dataset.fileName,
                    type: tds[1].textContent,
                    fileSize: Number(tds[2].textContent)
                };
            })
        );

        const expected = s2Directory
            .filter(e => e.fileName.endsWith('/SNG'))
            .map(e => ({ fileName: e.fileName, type: 'music', fileSize: e.fileSize }));

        expect(rendered).toEqual(expected);
        await page.close();
    });

    test('info bar shows the d64 filename', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const filename = await page.evaluate(() =>
            document.querySelector('.gm-disk-name .gm-disk-filename').textContent
        );

        expect(filename).toBe('gmc64-test.d64');
        await page.close();
    });

    test('double-clicking a file row loads it and closes the popup', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        // Pick a known file — MINUTE/SNG is alphabetically first /SNG entry
        await page.evaluate(() => {
            const rows = document.querySelectorAll('.gm-disk-files tr[data-index]');
            for (const row of rows) {
                if (row.dataset.fileName === 'MINUTE/SNG') {
                    row.click();  // sets the selection (browsers fire click before dblclick)
                    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                    return;
                }
            }
        });

        // Popup should close after selection; currentSongFileName updates
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        const loadedName = await page.evaluate(() => currentSongFileName);
        expect(loadedName).toBe('MINUTE/SNG');
        await page.close();
    });

    test('Load button loads the selected file (single-click + button)', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        await page.evaluate(() => {
            const rows = document.querySelectorAll('.gm-disk-files tr[data-index]');
            for (const row of rows) {
                if (row.dataset.fileName === 'MINUTE/SNG') {
                    row.click();
                    return;
                }
            }
        });
        // Load button should be enabled now
        const enabled = await page.$eval('.gm-disk-load', el => !el.disabled);
        expect(enabled).toBe(true);

        await page.click('.gm-disk-load');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        const loadedName = await page.evaluate(() => currentSongFileName);
        expect(loadedName).toBe('MINUTE/SNG');
        await page.close();
    });

    test('Load and Delete buttons are disabled until a file is selected', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const disabledBefore = await page.evaluate(() => ({
            load: document.querySelector('.gm-disk-load').disabled,
            del: document.querySelector('.gm-disk-delete').disabled
        }));
        expect(disabledBefore).toEqual({ load: true, del: true });

        await page.evaluate(() => {
            document.querySelector('.gm-disk-files tr[data-index]').click();
        });
        const disabledAfter = await page.evaluate(() => ({
            load: document.querySelector('.gm-disk-load').disabled,
            del: document.querySelector('.gm-disk-delete').disabled
        }));
        expect(disabledAfter).toEqual({ load: false, del: false });
        await page.close();
    });
});

describe('disk popup delete', () => {
    test('Delete button shows confirm prompt; "yes" removes the file from the disk', async () => {
        const page = await openPage();    // blank disk to start
        await openDiskPopup(page);

        // Save a file so there's something to delete
        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        await openDiskPopup(page);

        // Select the row + delete
        await page.evaluate(() => {
            document.querySelector('.gm-disk-files tr[data-index]').click();
        });
        await page.click('.gm-disk-delete');

        const promptState = await page.evaluate(() => {
            const prompt = document.querySelector('.gm-disk-delete-prompt');
            return {
                hidden: prompt.hidden,
                text: prompt.textContent.trim().replace(/\s+/g, ' ')
            };
        });
        expect(promptState.hidden).toBe(false);
        // Matches the overwrite-prompt format ("overwrite? yes  no") — the
        // selected row in the listing tells the user what they're deleting.
        expect(promptState.text).toMatch(/^delete\? yes\s+no$/i);

        await page.click('.gm-disk-delete-yes');

        const remaining = await page.evaluate(() => disk.disk.getDirectory().map(e => e.fileName));
        expect(remaining.some(f => /song1/i.test(f))).toBe(false);
        await page.close();
    });

    test('clicking outside the prompt cancels (anything that isn\'t "yes" acts as "no")', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        await openDiskPopup(page);

        await page.evaluate(() => {
            document.querySelector('.gm-disk-files tr[data-index]').click();
        });
        await page.click('.gm-disk-delete');

        // Click on an empty area of the popup (not on yes/no/button)
        await page.click('.popup-title');

        const state = await page.evaluate(() => ({
            promptHidden: document.querySelector('.gm-disk-delete-prompt').hidden,
            filesStillThere: disk.disk.getDirectory().some(e => /song1/i.test(e.fileName))
        }));
        expect(state.promptHidden).toBe(true);
        expect(state.filesStillThere).toBe(true);
        await page.close();
    });

    test('Delete "no" cancels and the file stays on disk', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        await page.focus('.gm-disk-name-input');
        await page.type('.gm-disk-name-input', 'song1');
        await page.click('.gm-disk-save');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));
        await openDiskPopup(page);

        await page.evaluate(() => {
            document.querySelector('.gm-disk-files tr[data-index]').click();
        });
        await page.click('.gm-disk-delete');
        await page.click('.gm-disk-delete-no');

        const stillThere = await page.evaluate(() => disk.disk.getDirectory().map(e => e.fileName));
        expect(stillThere.some(f => /song1/i.test(f))).toBe(true);
        await page.close();
    });
});

describe('disk popup "show all"', () => {
    test('toggle off (default) shows only the editor\'s file type', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const exts = await page.$$eval('.gm-disk-files tr[data-index]',
            rows => rows.map(r => r.dataset.fileName.split('/')[1]));
        // music-maker is the test page, so we only see /SNG
        expect(new Set(exts)).toEqual(new Set(['SNG']));
        await page.close();
    });

    test('toggle on shows all file types with non-loadable types dimmed', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);
        await page.click('.gm-disk-show-all');

        const listing = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.gm-disk-files tr'));
            return rows
                .filter(r => !r.classList.contains('gm-disk-group-gap'))
                .map(r => ({
                    name: r.dataset.fileName,
                    dimmed: r.classList.contains('gm-disk-row-dimmed'),
                    interactive: !!r.dataset.index
                }));
        });

        // Has multiple extensions (not just /SNG)
        const exts = new Set(listing.map(r => r.name?.split('/')[1]).filter(Boolean));
        expect(exts.size).toBeGreaterThan(1);

        // /SNG rows are not dimmed; other types are dimmed. ALL rows are
        // interactive now (selectable for delete); the loadability constraint
        // shows up in the Load button being disabled, not in the row itself.
        const sngRows = listing.filter(r => r.name?.endsWith('/SNG'));
        const otherRows = listing.filter(r => r.name && !r.name.endsWith('/SNG'));
        expect(sngRows.length).toBeGreaterThan(0);
        expect(sngRows.every(r => r.interactive && !r.dimmed)).toBe(true);
        expect(otherRows.length).toBeGreaterThan(0);
        expect(otherRows.every(r => r.interactive && r.dimmed)).toBe(true);
        await page.close();
    });

    test('selecting a non-primary (dimmed) row enables Delete but leaves Load disabled', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);
        await page.click('.gm-disk-show-all');

        // Click the first dimmed (non-primary) row
        await page.evaluate(() => {
            const row = document.querySelector('.gm-disk-files tr.gm-disk-row-dimmed[data-index]');
            row.click();
        });

        const btnState = await page.evaluate(() => ({
            load: document.querySelector('.gm-disk-load').disabled,
            del: document.querySelector('.gm-disk-delete').disabled
        }));
        expect(btnState.load).toBe(true);   // Can't load a non-primary file
        expect(btnState.del).toBe(false);   // But can delete it
        await page.close();
    });

    test('deleting a non-primary file in show-all mode removes it from the disk', async () => {
        const page = await openPage();   // blank disk
        await openDiskPopup(page);

        // Seed one /SPR (non-primary for music-maker) and refresh the listing
        await page.evaluate(() => {
            disk.disk.writeFile('TARGET/SPR', new Uint8Array(8), D64.FILE_TYPE_PRG);
            disk._updatePopupDirectory();
        });
        await page.click('.gm-disk-show-all');

        // Select the /SPR row and trigger delete
        await page.evaluate(() => {
            const row = document.querySelector('.gm-disk-files tr[data-file-name="TARGET/SPR"]');
            row.click();
        });
        await page.click('.gm-disk-delete');
        await page.click('.gm-disk-delete-yes');

        const stillThere = await page.evaluate(() =>
            disk.disk.getDirectory().some(e => e.fileName === 'TARGET/SPR')
        );
        expect(stillThere).toBe(false);
        await page.close();
    });

    test('primary type group sits above other types with a gap separator', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);
        await page.click('.gm-disk-show-all');

        const rowKinds = await page.$$eval('.gm-disk-files tr', rows =>
            rows.map(r => {
                if (r.classList.contains('gm-disk-group-gap')) return 'gap';
                const name = r.dataset.fileName || '';
                return name.endsWith('/SNG') ? 'primary' : 'other';
            }));

        const firstNonPrimary = rowKinds.findIndex(k => k !== 'primary');
        // All rows up to the first non-primary are primary, then a gap, then
        // the rest of the listing is "other" types or further gaps (multiple
        // groups separated by gaps — never a primary row mixed in below).
        expect(firstNonPrimary).toBeGreaterThan(0);
        expect(rowKinds.slice(0, firstNonPrimary).every(k => k === 'primary')).toBe(true);
        expect(rowKinds[firstNonPrimary]).toBe('gap');
        expect(rowKinds.slice(firstNonPrimary + 1).every(k => k === 'other' || k === 'gap')).toBe(true);
        await page.close();
    });

    test('non-primary groups appear in fixed order: SPR, PIC, SND, SNG, PRG (skipping the primary)', async () => {
        // We're on music-maker → primary = /SNG. Expected order of OTHER groups: SPR, PIC, SND, PRG.
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);
        await page.click('.gm-disk-show-all');

        const groupExts = await page.$$eval('.gm-disk-files tr', rows => {
            const exts = [];
            for (const r of rows) {
                if (r.classList.contains('gm-disk-group-gap')) continue;
                const name = r.dataset.fileName || '';
                const slash = name.lastIndexOf('/');
                const ext = slash >= 0 ? name.substring(slash) : '';
                if (exts[exts.length - 1] !== ext) exts.push(ext);
            }
            return exts;
        });

        expect(groupExts).toEqual(['/SNG', '/SPR', '/PIC', '/SND', '/PRG']);
        await page.close();
    });

    test('toggle state persists across popup close + reopen', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);
        await page.click('.gm-disk-show-all');
        await page.click('.gm-disk-close');
        await page.waitForFunction(() => !document.querySelector('.gm-disk-dialog'));

        await openDiskPopup(page);
        const state = await page.evaluate(() => ({
            buttonActive: document.querySelector('.gm-disk-show-all').classList.contains('active'),
            hasDimmedRows: !!document.querySelector('.gm-disk-row-dimmed')
        }));
        expect(state.buttonActive).toBe(true);
        expect(state.hasDimmedRows).toBe(true);
        await page.close();
    });
});

describe('disk popup GM-filename filter', () => {
    test('files that do not match the GM shape (6 chars + / + known 3-char ext) are hidden', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        // Write a few non-GM files directly via the D64 API, plus one valid one.
        // Then trigger a directory refresh so the listing picks them up.
        await page.evaluate(() => {
            const TYPE = D64.FILE_TYPE_PRG;
            disk.disk.writeFile('SHORT', new Uint8Array(8), TYPE);          // no slash
            disk.disk.writeFile('FOOBAR/TXT', new Uint8Array(8), TYPE);     // unknown ext
            disk.disk.writeFile('AB/SPR', new Uint8Array(8), TYPE);         // basename too short
            disk.disk.writeFile('VALID /SNG', new Uint8Array(8), TYPE);     // valid GM file
            disk._updatePopupDirectory();
        });
        await page.click('.gm-disk-show-all');

        const shown = await page.$$eval('.gm-disk-files tr',
            rows => rows
                .filter(r => !r.classList.contains('gm-disk-group-gap'))
                .map(r => r.dataset.fileName)
                .filter(Boolean)
        );

        expect(shown).toContain('VALID /SNG');
        expect(shown).not.toContain('SHORT');
        expect(shown).not.toContain('FOOBAR/TXT');
        expect(shown).not.toContain('AB/SPR');
        await page.close();
    });
});

describe('disk pool', () => {
    test('New Disk button prompts for a name, ok accepts the auto-numbered suggestion', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const before = await page.evaluate(() => GMDisk.getPool().length);
        // Open the prompt — auto-numbered suggestion lands in the input,
        // selected. Confirming accepts that name.
        await page.click('.gm-disk-blank');
        await page.waitForSelector('.gm-disk-name-prompt:not([hidden])');
        await page.click('.gm-disk-name-prompt-ok');
        // createBlank is async (SHA-256 hashing); wait for selection to flip.
        await page.waitForFunction(() => /^NEW DISK \d{2}\.d64$/.test(disk.diskFileName || ''));

        const after = await page.evaluate(() => ({
            poolSize: GMDisk.getPool().length,
            selectedDiskName: disk.disk ? disk.disk.getDiskName() : null,
            selectedFileName: disk.diskFileName
        }));

        expect(after.poolSize).toBe(before + 1);
        expect(after.selectedDiskName).toMatch(/^NEW DISK \d{2}$/);
        expect(after.selectedFileName).toMatch(/^NEW DISK \d{2}\.d64$/);
        await page.close();
    });

    test('inserting the same disk twice deduplicates by content hash', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const initialPool = await page.evaluate(() => GMDisk.getPool().length);

        // Re-add the same bytes under a different name; should resolve to the existing entry
        const result = await page.evaluate(async (data) => {
            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const id = await GMDisk.addToPool(bytes, 'a-different-name.d64');
            return { id, poolSize: GMDisk.getPool().length };
        }, s2DiskBase64);

        expect(result.poolSize).toBe(initialPool); // no new entry
        await page.close();
    });

    test('inserting same filename with different bytes prompts to replace, "yes" replaces', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        // Mutate the in-memory disk so it hashes differently, then try to insert
        // the original S2 bytes back with the same filename
        const promptResult = await page.evaluate(async (data) => {
            // Simulate edit: append a file so the pool entry's hash changes
            disk.saveFile('TESTSV/SNG', new Uint8Array([1, 2, 3, 4]));

            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            // Kick off insert (resolves when replace prompt is answered)
            const insertPromise = disk._insertBytes(bytes, 'gmc64-test.d64');
            // Promise hasn't resolved yet — prompt should be visible
            await new Promise(r => setTimeout(r, 50));
            const promptVisible = !document.querySelector('.gm-disk-replace-prompt').hidden;
            const promptText = document.querySelector('.gm-disk-replace-prompt').textContent.trim();

            // Click yes
            document.querySelector('.gm-disk-replace-yes').click();
            const ok = await insertPromise;

            return {
                promptVisible,
                promptText,
                ok,
                poolNames: GMDisk.getPool().map(e => e.name)
            };
        }, s2DiskBase64);

        expect(promptResult.promptVisible).toBe(true);
        expect(promptResult.promptText).toMatch(/replace existing.*gmc64-test\.d64/i);
        expect(promptResult.ok).toBe(true);
        // Only one entry by that name remains
        expect(promptResult.poolNames.filter(n => n === 'gmc64-test.d64').length).toBe(1);
        await page.close();
    });

    test('replace prompt "no" leaves both pool and selection untouched', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const result = await page.evaluate(async (data) => {
            disk.saveFile('TESTSV/SNG', new Uint8Array([1, 2, 3, 4]));
            const beforeSize = GMDisk.getPool().length;

            const binary = atob(data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const insertPromise = disk._insertBytes(bytes, 'gmc64-test.d64');
            await new Promise(r => setTimeout(r, 50));
            document.querySelector('.gm-disk-replace-no').click();
            const ok = await insertPromise;

            return { ok, afterSize: GMDisk.getPool().length, beforeSize };
        }, s2DiskBase64);

        expect(result.ok).toBe(false);
        expect(result.afterSize).toBe(result.beforeSize);
        await page.close();
    });

    test('disk picker still works after ejecting all disks then inserting a new one', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        // Eject everything until pool is empty
        await page.evaluate(() => {
            while (GMDisk.getPool().length > 0) disk.clear();
            disk._updatePopupDirectory();
        });

        // Insert via Blank (simulates the real-world recovery path). New
        // Disk now opens a name prompt — confirm to create.
        await page.click('.gm-disk-blank');
        await page.waitForSelector('.gm-disk-name-prompt:not([hidden])');
        await page.click('.gm-disk-name-prompt-ok');
        await page.waitForFunction(() => /^NEW DISK \d{2}\.d64$/.test(disk.diskFileName || ''));

        // Click the picker — dropdown should open and stay open (previously it
        // would flash open then immediately close because attach() had stacked
        // duplicate mousedown listeners during the empty-pool recovery)
        await page.click('.gm-disk-name');
        await new Promise(r => setTimeout(r, 100));

        const dropdownVisible = await page.evaluate(() => {
            const dd = document.querySelector('.draggable-dropdown-overlay');
            return dd && dd.style.display === 'block';
        });
        expect(dropdownVisible).toBe(true);
        await page.close();
    });

    test('two consecutive New Disk confirms produce two distinct disks', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        const before = await page.evaluate(() => GMDisk.getPool().length);

        // First New Disk: open prompt, confirm with the auto-numbered suggestion.
        await page.click('.gm-disk-blank');
        await page.waitForSelector('.gm-disk-name-prompt:not([hidden])');
        await page.click('.gm-disk-name-prompt-ok');
        await page.waitForFunction((n) => GMDisk.getPool().length === n + 1, {}, before);

        // Second: same flow. Auto-number bumps so the names are distinct.
        await page.click('.gm-disk-blank');
        await page.waitForSelector('.gm-disk-name-prompt:not([hidden])');
        await page.click('.gm-disk-name-prompt-ok');
        await page.waitForFunction((n) => GMDisk.getPool().length === n + 2, {}, before);

        const after = await page.evaluate(() => GMDisk.getPool().length);
        expect(after).toBe(before + 2);
        await page.close();
    });

    test('Eject removes the current disk from the pool globally (after confirm)', async () => {
        const page = await openPage({ disk: 's2' });
        await openDiskPopup(page);

        // Sanity: pool has the S2 disk
        const before = await page.evaluate(() => GMDisk.getPool().map(e => e.name));
        expect(before).toContain('gmc64-test.d64');

        // Eject now opens a yes/no confirm — destructive, since the disk
        // is removed from the pool if not downloaded first.
        await page.click('.gm-disk-eject');
        await page.waitForSelector('.gm-disk-eject-prompt:not([hidden])');
        await page.click('.gm-disk-eject-yes');

        const after = await page.evaluate(() => GMDisk.getPool().map(e => e.name));
        expect(after).not.toContain('gmc64-test.d64');
        await page.close();
    });

    test('legacy per-tool localStorage entry is silently migrated into the pool', async () => {
        const page = await openPage({ disk: 's2' });

        // After the page boots, the legacy keys should be gone and the pool seeded
        const state = await page.evaluate(() => ({
            poolNames: GMDisk.getPool().map(e => e.name),
            legacyDataKey: localStorage.getItem('gm_disk_music-maker'),
            legacyNameKey: localStorage.getItem('gm_disk_music-maker_name'),
            selectionKey: localStorage.getItem('gm_disk_selection_music-maker'),
            currentlyLoaded: disk.disk ? disk.disk.getDiskName() : null
        }));

        expect(state.poolNames).toContain('gmc64-test.d64');
        expect(state.legacyDataKey).toBeNull();
        expect(state.legacyNameKey).toBeNull();
        expect(state.selectionKey).toBeTruthy();
        expect(state.currentlyLoaded).toBe('GMC64 TEST');
        await page.close();
    });
});

describe('disk popup custom buttons', () => {
    test('music-maker renders Import MIDI and Export MIDI buttons', async () => {
        const page = await openPage();
        await openDiskPopup(page);

        const labels = await page.$$eval('.gm-disk-custom', btns =>
            btns.map(b => b.textContent.trim())
        );
        expect(labels.some(l => /import midi/i.test(l))).toBe(true);
        expect(labels.some(l => /export midi/i.test(l))).toBe(true);
        await page.close();
    });
});
