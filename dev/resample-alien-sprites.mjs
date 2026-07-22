// Resample alien sprites from the original strip into 1:1 hi-res green.
// Rule: each 2x2 source block -> one hi-res pixel; non-black -> green, black/transparent -> bg.
// Run: node /Users/jfield/GMC64/code/dev/resample-alien-sprites.mjs   (needs puppeteer, hence dev/)
import { readFileSync, writeFileSync } from 'fs';
import puppeteer from 'puppeteer';
const B='/Users/jfield/GMC64/code/js/';
for (const f of ['d64lib','c64lib','gmSprite']) await import(B+f+'.js');
const { D64, gmSprite } = globalThis;
const DISK='/Users/jfield/GMC64/quadropus/quadropus.d64';
const IMG='/Users/jfield/GMC64/quadropus/images/alienstrip.gif';
const GREEN=0x05, VOFF=1;                 // 18 logical rows placed at hi-res rows 1..18
// NOTE: ALIEN and EXPLOD are HAND-EDITED on the disk — do NOT regenerate them here
// or you'll clobber those edits. Only tool-generated sprites belong in JOBS. To add
// a frame to a hand-edited sprite, use add-blank-frame.mjs (byte-level, non-destructive).
const JOBS=[                              // frame indices into the 20-frame strip
  { name:'ATTACK', frames:[8,9,10,11,12,13,14,15] },    // dive
];

const browser=await puppeteer.launch({headless:true}); const page=await browser.newPage();
const b64=readFileSync(IMG).toString('base64');
async function extract(indices){
  return page.evaluate(async (url, idx)=>{
    const img=new Image(); await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src=url;});
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    return idx.map(f=>Array.from(ctx.getImageData(f*48,0,48,36).data));
  }, `data:image/gif;base64,${b64}`, indices);
}
const fg=(rgba,x,y)=>{ const i=(y*48+x)*4; return rgba[i+3]>=128 && (rgba[i]+rgba[i+1]+rgba[i+2])>60; };
const blockSet=(rgba,px,lr)=>{ let n=0; for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) if(fg(rgba,px*2+dx,lr*2+dy)) n++; return n>=2; };

const disk=new D64(new Uint8Array(readFileSync(DISK)));
const previewRows=[];
for(const job of JOBS){
  const framesRGBA=await extract(job.frames);
  const blank=job.blank||0;
  const sprite=gmSprite.createBlank({ name:job.name, isMultiColor:false, numFrames:job.frames.length+blank, bgColor:0, gmColor1:GREEN });
  framesRGBA.forEach((rgba,f)=>{
    const buf=new Uint8Array(64);
    for(let lr=0;lr<18;lr++){ const row=lr+VOFF;
      for(let bc=0;bc<3;bc++){ let byte=0;
        for(let bit=0;bit<8;bit++){ if(blockSet(rgba, bc*8+bit, lr)) byte|=(1<<(7-bit)); }
        buf[row*3+bc]=byte; } }
    sprite.sprite[0].imageData[f]=buf;
  });
  for(let f=job.frames.length; f<job.frames.length+blank; f++) sprite.sprite[0].imageData[f]=new Uint8Array(64); // trailing blank frame(s)
  const spr=sprite.serialize();
  const fn=job.name.padEnd(6,' ')+'/SPR';
  if(disk.readFile(fn)) disk.deleteFile(fn);
  disk.writeFile(fn, spr, D64.FILE_TYPE_PRG);
  const rt=new gmSprite(spr);
  const frs=[]; for(let f=0;f<rt.getNumFrames();f++){ const fr=rt.getFrame(0,f); frs.push({w:fr.width,h:fr.height,px:Array.from(fr.pixels)}); }
  previewRows.push({name:job.name, frs});
  console.log(`${fn}: ${rt.getNumFrames()} frames, mc=${rt.sprite[0].isMultiColor} (hi-res), ${spr.length}b`);
}
writeFileSync(DISK, Buffer.from(disk.getData()));

// preview: one row per sprite
const SCALE=5,PAD=5,CW=24*SCALE,CH=21*SCALE, cols=Math.max(...previewRows.map(r=>r.frs.length));
const W=PAD+cols*(CW+PAD), Ht=PAD+previewRows.length*(CH+PAD+10);
const png=await page.evaluate((rows,SCALE,PAD,CW,CH,W,Ht)=>{
  const c=document.createElement('canvas'); c.width=W;c.height=Ht; const ctx=c.getContext('2d');
  ctx.fillStyle='#181818'; ctx.fillRect(0,0,W,Ht); ctx.imageSmoothingEnabled=false;
  ctx.font='9px monospace'; ctx.fillStyle='#8fdcff'; ctx.textBaseline='top';
  let y=PAD;
  for(const row of rows){ ctx.fillStyle='#8fdcff'; ctx.fillText(row.name,PAD,y); y+=10;
    row.frs.forEach((fr,i)=>{ const t=document.createElement('canvas'); t.width=fr.w;t.height=fr.h;
      const id=t.getContext('2d').createImageData(fr.w,fr.h); id.data.set(fr.px); t.getContext('2d').putImageData(id,0,0);
      ctx.drawImage(t,0,0,fr.w,fr.h,PAD+i*(CW+PAD),y,fr.w*SCALE,fr.h*SCALE); });
    y+=CH+PAD; }
  return c.toDataURL('image/png').split(',')[1];
}, previewRows,SCALE,PAD,CW,CH,W,Ht);
writeFileSync('/Users/jfield/GMC64/quadropus/alien-sprites-preview.png', Buffer.from(png,'base64'));
await browser.close();
console.log('wrote sprites + preview; free', disk.getFreeBlocks());
