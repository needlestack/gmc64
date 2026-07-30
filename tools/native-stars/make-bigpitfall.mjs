// make-bigpitfall.mjs — author extra Pitfall scenes and splice PITFAL to cycle
// through them, producing a program whose roomy image spans past $d000 (so it
// exercises the self-extractor's I/O-hole hop). Writes a temp .d64 that
// compile-game then compiles.
//
//   node make-bigpitfall.mjs <src.d64> <out.d64>
//
// Scenes are NOT embedded in the PRG — they live as .PIC files on the disk and
// are referenced by name. So we: build new .PIC files (mirrored + recolored
// jungle variants), add "scene K is <name>" instructions, and re-serialize.

import { readFileSync, writeFileSync } from 'fs';
const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib', 'c64lib', 'gmOpcodes', 'gmSprite', 'gmScene', 'gmSound', 'gmMusic', 'gmCharset', 'gmParser']) await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const srcDisk = process.argv[2], outDisk = process.argv[3];
const disk = new globalThis.D64(new Uint8Array(readFileSync(srcDisk)));
globalThis.loadFileByName = (name) => disk.readFile(name);
const gmScene = globalThis.gmScene;

// ---- pixelBuffer (160x200 palette indices) -> rawImageData (C64 mc bitmap order) ----
// inverse of gmScene.unpackToBuffer: tiles left-to-right then down, 8 rows/tile,
// each byte = 4 fat pixels MSB-first (bits 7-6 leftmost).
function packBufferToRaw(buf) {
  const raw = new Uint8Array(8000);
  let di = 0;
  for (let ty = 0; ty < 25; ty++)
    for (let tx = 0; tx < 40; tx++)
      for (let r = 0; r < 8; r++) {
        const y = ty * 8 + r, x = tx * 4;
        raw[di++] = (buf[y * 160 + x] << 6) | (buf[y * 160 + x + 1] << 4) | (buf[y * 160 + x + 2] << 2) | buf[y * 160 + x + 3];
      }
  return raw;
}
// build a .PIC file (6-byte header, 8000 image bytes, 10-byte footer) from raw + palette + name
function makePic(raw, { color1, color2, color3, bgColor }, name) {
  const pic = new Uint8Array(6 + 8000 + 10);   // header byte 5 = 0 (not $FF) -> uncompressed
  pic.set(raw, 6);
  const f = 6 + 8000;
  pic[f + 0] = ((color1 & 0xf) << 4) | (color2 & 0xf);
  pic[f + 1] = color3 & 0xf;
  pic[f + 2] = bgColor & 0xf;
  const nm = globalThis.encodeString ? globalThis.encodeString(name, 6) : name.padEnd(6).split('').map(c => c.charCodeAt(0));
  for (let i = 0; i < 6; i++) pic[f + 3 + i] = nm[i];
  return pic;
}
// transforms on a 160x200 buffer
const mirrorH = buf => { const o = new Uint8Array(buf.length); for (let y = 0; y < 200; y++) for (let x = 0; x < 160; x++) o[y * 160 + x] = buf[y * 160 + (159 - x)]; return o; };
const shiftX = (buf, dx) => { const o = new Uint8Array(buf.length); for (let y = 0; y < 200; y++) for (let x = 0; x < 160; x++) o[y * 160 + x] = buf[y * 160 + ((x - dx + 160) % 160)]; return o; };

// ---- parse PITFAL + grab the two base scenes ----
const pd = globalThis.parseProgramData(disk.readFile('PITFAL/PRG'));
const sceneEntry = pd.mediaStore.filter(e => e && e.type === 'scene');
const jungl1 = sceneEntry.find(e => e.name.trim() === 'jungl1').scene;
const jungl2 = sceneEntry.find(e => e.name.trim() === 'jungl2').scene;
jungl1.unpackToBuffer(); jungl2.unpackToBuffer();  // ensure pixelBuffer populated

// ---- author 3 new scenes: mirrored/shifted + recolored variants ----
// palette = [color1,color2,color3,bgColor] as C64 indices; layout distinct per scene.
const variants = [
  { name: 'jungl3', base: jungl1, xf: mirrorH,          pal: { color1: 11, color2: 12, color3: 15, bgColor: 0 } },  // cavern: grays on black
  { name: 'jungl4', base: jungl2, xf: mirrorH,          pal: { color1: 8,  color2: 2,  color3: 7,  bgColor: 9 } },  // sunset: orange/red/yellow on brown
  { name: 'jungl5', base: jungl1, xf: b => shiftX(b, 80), pal: { color1: 14, color2: 4,  color3: 1,  bgColor: 6 } }, // night: lt-blue/purple/white on blue
];
const newPics = {};
const newScenes = variants.map(v => {
  const buf = v.xf(v.base.pixelBuffer);
  const raw = packBufferToRaw(buf);
  const sc = gmScene.createBlank ? gmScene.createBlank(0, 0, 0, 0) : new gmScene(null);
  sc.rawImageData = raw; sc.pixelBuffer = buf;
  sc._color1 = v.pal.color1; sc._color2 = v.pal.color2; sc._color3 = v.pal.color3; sc._bgColor = v.pal.bgColor;
  sc.name = v.name;
  newPics[`${v.name.padEnd(6)}/PIC`] = makePic(raw, v.pal, v.name);
  return { name: v.name, scene: sc };
});

// ---- add mediaStore entries + "scene K is <name>" instructions ----
// existing: scene 1 is jungl1 (slot0), scene 2 is jungl2 (slot1). add slots 2,3,4.
const baseIdx = pd.mediaStore.length;
newScenes.forEach((ns, i) => { pd.mediaStore[baseIdx + i] = { name: ns.name, type: 'scene', scene: ns.scene }; });
// find the last existing 0x28 to insert after
let last28 = -1;
pd.instructions.forEach((ins, idx) => { if (ins.opcode === 0x28) last28 = idx; });
const newIns = newScenes.map((ns, i) => ({ label: 0, arg1: 2 + i, opcode: 0x28, arg2: baseIdx + i, instructionName: `scene ${3 + i} is ${ns.name}` }));
pd.instructions.splice(last28 + 1, 0, ...newIns);
console.log(`added ${newScenes.length} scenes (${newScenes.map(n => n.name).join(', ')}); inserted ${newIns.length} 0x28 instrs after idx ${last28}`);

// ---- serialize + write a FRESH temp disk with only what compile-game needs:
//      the modified PRG (sprites/sounds are embedded in it) + every scene .PIC. ----
const newPrg = globalThis.serializeProgram(pd);
const out = globalThis.D64.createEmpty('BIGPITFALL', '01');
out.writeFile('PITFAL/PRG', newPrg, globalThis.D64.FILE_TYPE_PRG);
// carry the two base scene PICs over from the source disk
for (const n of ['jungl1', 'jungl2']) out.writeFile(`${n.padEnd(6)}/PIC`, disk.readFile(`${n.padEnd(6)}/PIC`), globalThis.D64.FILE_TYPE_PRG);
for (const [fname, bytes] of Object.entries(newPics)) out.writeFile(fname, bytes, globalThis.D64.FILE_TYPE_PRG);
writeFileSync(outDisk, Buffer.from(out.getData()));
console.log(`-> ${outDisk}  (PITFAL/PRG ${newPrg.length}B, + ${2 + Object.keys(newPics).length} PICs, ${out.getFreeBlocks()} blocks free)`);
console.log(`   scene .PICs on disk: ${['jungl1', 'jungl2', ...newScenes.map(n => n.name)].join(', ')}`);
