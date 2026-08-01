// make-cycler.mjs — a MINIMAL roomy program that just cycles the 5 jungle scenes
// on a timer. Isolates the N-scene + hole-hop + display_scene machinery from
// PITFAL's gameplay, so we can tell whether a scene garbles because of the scene
// system itself or because of something PITFAL does during play.
//
//   node make-cycler.mjs <src.d64> <out.d64>

import { readFileSync, writeFileSync } from 'fs';
const B = '../js/';
for (const m of ['d64lib', 'c64lib', 'gmOpcodes', 'gmSprite', 'gmScene', 'gmSound', 'gmMusic', 'gmCharset', 'gmParser']) await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const srcDisk = process.argv[2], outDisk = process.argv[3];
const disk = new globalThis.D64(new Uint8Array(readFileSync(srcDisk)));
globalThis.loadFileByName = (name) => disk.readFile(name);
const gmScene = globalThis.gmScene;

function packBufferToRaw(buf) {
  const raw = new Uint8Array(8000); let di = 0;
  for (let ty = 0; ty < 25; ty++) for (let tx = 0; tx < 40; tx++) for (let r = 0; r < 8; r++) {
    const y = ty * 8 + r, x = tx * 4;
    raw[di++] = (buf[y * 160 + x] << 6) | (buf[y * 160 + x + 1] << 4) | (buf[y * 160 + x + 2] << 2) | buf[y * 160 + x + 3];
  }
  return raw;
}
function makePic(raw, { color1, color2, color3, bgColor }, name) {
  const pic = new Uint8Array(6 + 8000 + 10); pic.set(raw, 6); const f = 6 + 8000;
  pic[f] = ((color1 & 0xf) << 4) | (color2 & 0xf); pic[f + 1] = color3 & 0xf; pic[f + 2] = bgColor & 0xf;
  const nm = globalThis.encodeString(name, 6); for (let i = 0; i < 6; i++) pic[f + 3 + i] = nm[i];
  return pic;
}
const mirrorH = b => { const o = new Uint8Array(b.length); for (let y = 0; y < 200; y++) for (let x = 0; x < 160; x++) o[y * 160 + x] = b[y * 160 + (159 - x)]; return o; };
const shiftX = (b, dx) => { const o = new Uint8Array(b.length); for (let y = 0; y < 200; y++) for (let x = 0; x < 160; x++) o[y * 160 + x] = b[y * 160 + ((x - dx + 160) % 160)]; return o; };

const pd = globalThis.parseProgramData(disk.readFile('PITFAL/PRG'));
const se = pd.mediaStore.filter(e => e && e.type === 'scene');
const jungl1 = se.find(e => e.name.trim() === 'jungl1').scene;
const jungl2 = se.find(e => e.name.trim() === 'jungl2').scene;
jungl1.unpackToBuffer(); jungl2.unpackToBuffer();

const variants = [
  { name: 'jungl3', base: jungl1, xf: mirrorH, pal: { color1: 11, color2: 12, color3: 15, bgColor: 0 } },
  { name: 'jungl4', base: jungl2, xf: mirrorH, pal: { color1: 8, color2: 2, color3: 7, bgColor: 9 } },
  { name: 'jungl5', base: jungl1, xf: b => shiftX(b, 80), pal: { color1: 14, color2: 4, color3: 1, bgColor: 6 } },
  { name: 'jungl6', base: jungl2, xf: b => shiftX(b, 40), pal: { color1: 10, color2: 8, color3: 7, bgColor: 0 } },
  { name: 'jungl7', base: jungl1, xf: b => shiftX(mirrorH(b), 60), pal: { color1: 3, color2: 14, color3: 1, bgColor: 6 } },
  { name: 'jungl8', base: jungl2, xf: b => shiftX(b, 120), pal: { color1: 5, color2: 13, color3: 1, bgColor: 0 } },
];
const newPics = {};
const scenes = [{ name: 'jungl1', scene: jungl1 }, { name: 'jungl2', scene: jungl2 }];
for (const v of variants) {
  const buf = v.xf(v.base.pixelBuffer), raw = packBufferToRaw(buf);
  const sc = gmScene.createBlank(0, 0, 0, 0);
  sc.rawImageData = raw; sc.pixelBuffer = buf;
  sc._color1 = v.pal.color1; sc._color2 = v.pal.color2; sc._color3 = v.pal.color3; sc._bgColor = v.pal.bgColor; sc.name = v.name;
  newPics[`${v.name.padEnd(6)}/PIC`] = makePic(raw, v.pal, v.name);
  scenes.push({ name: v.name, scene: sc });
}

// fresh minimal program: 5 scene-slot setups, then cycle-with-pause loop
pd.mediaStore = [null];
scenes.forEach((s, i) => { pd.mediaStore[i + 1] = { name: s.name, type: 'scene', scene: s.scene }; });
pd.instructions = [
  ...scenes.map((s, i) => ({ label: 0, arg1: i, opcode: 0x28, arg2: i + 1, instructionName: `scene ${i + 1} is ${s.name}` })),
  { label: 1, arg1: 0, opcode: 0x56, arg2: 0, instructionName: 'display other scene' },
  { label: 0, arg1: 0, opcode: 0x57, arg2: 15, instructionName: 'pause for 01.5 seconds' },
  { label: 0, arg1: 0, opcode: 0x01, arg2: 1, instructionName: 'jump to label l001' },
];

const newPrg = globalThis.serializeProgram(pd);
const out = globalThis.D64.createEmpty('CYCLER', '01');
out.writeFile('PITFAL/PRG', newPrg, globalThis.D64.FILE_TYPE_PRG);
for (const n of ['jungl1', 'jungl2']) out.writeFile(`${n.padEnd(6)}/PIC`, disk.readFile(`${n.padEnd(6)}/PIC`), globalThis.D64.FILE_TYPE_PRG);
for (const [f, b] of Object.entries(newPics)) out.writeFile(f, b, globalThis.D64.FILE_TYPE_PRG);
writeFileSync(outDisk, Buffer.from(out.getData()));
console.log(`-> ${outDisk}  (cycler PRG ${newPrg.length}B, ${scenes.length} scenes: ${scenes.map(s => s.name).join(', ')})`);
