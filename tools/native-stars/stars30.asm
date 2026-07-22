; ============================================================================
; STARS — native 6502 reimplementation of the GKGM STARS/PRG parallax starfield
; (from quadropus.d64).  3 layers x 5 stars, speeds 1/2/3, 3 grays on black,
; C64 multicolor bitmap.  Frame-synced: all stars update every video frame
; (GKGM managed ~1 update per 5 frames).
;
; Built with GMC64's own asm6502.mjs.  Run: LOAD"STARS",8,1 : RUN   (or drag
; the .prg into VICE).  v1 = starfield only; measurement/readout plumbing is
; stubbed (see `upd` counter + the FUTURE markers) for the next iteration.
;
; Memory map (VIC bank 0):
;   $0400-$07FF  screen matrix   (color source: nibble hi=gray1, lo=gray2)
;   $0801-       BASIC stub + code + tables
;   $2000-$3F3F  bitmap (8000 bytes)
;   $D800-$DBFF  color RAM       (bit-pair 11 = gray3)
; ============================================================================

BITMAP  = $2000
SCREEN  = $0400
COLRAM  = $D800

; --- zero page (we SEI and own the machine, so BASIC/KERNAL scratch is ours) ---
ptr     = $fb          ; $fb/$fc  plot address pointer
px      = $10          ; plot X   (multicolor 0..159)
py      = $11          ; plot Y   (0..199)
pbits   = $12          ; bit-pair to write (0=erase, 1/2/3=layer)
tmpval  = $14
tmpmask = $15
si      = $16          ; current star index
lcount  = $17          ; stars left in this layer
lspeed  = $18          ; layer scroll speed
lbits   = $19          ; layer color bit-pair
upd     = $1a          ; $1a/$1b  update counter (FUTURE: per-frame readout)
tmp     = $1c          ; $1c/$1d  scratch for table building

; ---------------------------------------------------------------------------
        * = $0801
; BASIC:  10 SYS 2061
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00

; ---------------------------------------------------------------------------
entry:                          ; = $080d = 2061
        sei
        lda #$00
        sta $d01a               ; no VIC interrupts (we poll the raster)

        ; --- VIC bank 0, multicolor bitmap mode ---
        lda $dd00
        ora #$03
        sta $dd00               ; VIC sees $0000-$3FFF
        lda #$3b
        sta $d011               ; bitmap mode on (BMM), display enabled
        lda #$18
        sta $d016               ; multicolor on (MCM)
        lda #$18
        sta $d018               ; screen matrix $0400, bitmap $2000
        lda #$00
        sta $d020               ; black border
        sta $d021               ; black background (bit-pair 00)

        ; --- fill screen matrix with $BC: hi nibble $B=gray1, lo $C=gray2 ---
        lda #$bc
        ldx #$00
fillsc: sta SCREEN,x
        sta SCREEN+$100,x
        sta SCREEN+$200,x
        sta SCREEN+$300,x
        inx
        bne fillsc

        ; --- fill color RAM with $0F (light gray) for bit-pair 11 = gray3 ---
        lda #$0f
        ldx #$00
fillcr: sta COLRAM,x
        sta COLRAM+$100,x
        sta COLRAM+$200,x
        sta COLRAM+$300,x
        inx
        bne fillcr

        ; --- clear the 8K bitmap to 0 (all pixels = background/black) ---
        lda #<BITMAP
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldx #$20                ; 32 pages = 8K
        lda #$00
clrpg:  ldy #$00
clrby:  sta (ptr),y
        iny
        bne clrby
        inc ptr+1
        dex
        bne clrpg

        jsr build_tables

        ; --- seed live star Y from the initial-Y table (X stays constant) ---
        ldx #$00
seedy:  lda initMY,x
        sta starMY,x
        inx
        cpx #NSTARS
        bne seedy

; ---------------------------------------------------------------------------
; main loop: once per video frame, update every star.
; ---------------------------------------------------------------------------
main:
wframe: lda $d012
        cmp #250
        bne wframe              ; sync to raster line 250 (once per frame)

        lda #$00
        sta si                  ; start at star 0; do_layer advances si

        ; layer 1 — slow, gray1 (bit-pair 01)
        lda #10
        sta lcount
        lda #1
        sta lspeed
        sta lbits
        jsr do_layer

        ; layer 2 — medium, gray2 (bit-pair 10)
        lda #10
        sta lcount
        lda #2
        sta lspeed
        sta lbits
        jsr do_layer

        ; layer 3 — fast, gray3 (bit-pair 11)
        lda #10
        sta lcount
        lda #3
        sta lspeed
        sta lbits
        jsr do_layer

        jmp main

; ---------------------------------------------------------------------------
; do_layer: process `lcount` stars starting at `si`, moving by `lspeed`,
; drawing with `lbits`.  Advances `si` past the layer on return.
; ---------------------------------------------------------------------------
do_layer:
dl_lp:  ldx si
        lda starMX,x
        sta px                  ; px = star X (constant per star)
        lda starMY,x
        sta py                  ; py = old Y
        lda #$00
        sta pbits
        jsr plotdot             ; erase old position

        ldx si
        lda starMY,x
        clc
        adc lspeed
        cmp #200
        bcc dl_now              ; wrap: y>199 -> y-200  (GKGM: c>249 -> c-200)
        sbc #200                ; carry set by cmp, so this is A-200
dl_now: sta starMY,x
        sta py                  ; py = new Y  (px unchanged)
        lda lbits
        sta pbits
        jsr plotdot             ; draw new position

        inc upd                 ; FUTURE: readout reads this counter
        bne dl_noc
        inc upd+1
dl_noc: inc si
        dec lcount
        bne dl_lp
        rts

; ---------------------------------------------------------------------------
; plotdot: set the 2-bit multicolor pixel at (px,py) to `pbits`.
;   addr = ylo/yhi[py] + xoff[px] ; position within byte = px & 3
; ---------------------------------------------------------------------------
plotdot:
        ldx py
        lda ylo,x
        sta ptr
        lda yhi,x
        sta ptr+1
        ldx px
        lda xoff_lo,x
        clc
        adc ptr
        sta ptr
        lda xoff_hi,x
        adc ptr+1
        sta ptr+1
        ; value byte: valtab[(px&3)*4 + pbits]
        lda px
        and #$03
        asl
        asl
        ora pbits
        tax
        lda valtab,x
        sta tmpval
        ; clear-mask: maskt[px&3]
        lda px
        and #$03
        tax
        lda maskt,x
        sta tmpmask
        ldy #$00
        lda (ptr),y
        and tmpmask
        ora tmpval
        sta (ptr),y
        rts

; ---------------------------------------------------------------------------
; build_tables: ylo/yhi[200] = BITMAP + (my>>3)*320 + (my&7)
;               xoff_lo/hi[160] = (mx>>2)*8
; ---------------------------------------------------------------------------
build_tables:
        ; ylo/yhi via a running pointer that adds 1 within a cell, +313 across
        lda #<BITMAP
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldx #$00
byrow:  lda ptr
        sta ylo,x
        lda ptr+1
        sta yhi,x
        txa
        and #$07
        cmp #$07
        beq bycell              ; last row of cell -> jump to next cell row
        clc                     ; else +1
        lda ptr
        adc #$01
        sta ptr
        lda ptr+1
        adc #$00
        sta ptr+1
        jmp bynext
bycell: clc                     ; +313 to reach start of next cell row
        lda ptr
        adc #<313
        sta ptr
        lda ptr+1
        adc #>313
        sta ptr+1
bynext: inx
        cpx #200
        bne byrow

        ; xoff[mx] = (mx>>2)*8
        ldx #$00
bxlp:   txa
        lsr
        lsr                     ; A = mx>>2 (0..39)
        sta tmp
        lda #$00
        sta tmp+1
        asl tmp                 ; *2
        rol tmp+1
        asl tmp                 ; *4
        rol tmp+1
        asl tmp                 ; *8
        rol tmp+1
        lda tmp
        sta xoff_lo,x
        lda tmp+1
        sta xoff_hi,x
        inx
        cpx #160
        bne bxlp
        rts

; ---------------------------------------------------------------------------
; static data
; ---------------------------------------------------------------------------
NSTARS  = 30

; value table: valtab[(pos*4)+bits] = bits << ((3-pos)*2)
valtab: !byte $00,$40,$80,$c0    ; pos 0 (leftmost, shift 6)
        !byte $00,$10,$20,$30    ; pos 1 (shift 4)
        !byte $00,$04,$08,$0c    ; pos 2 (shift 2)
        !byte $00,$01,$02,$03    ; pos 3 (rightmost, shift 0)
; clear-mask per position (keep the other 3 pixels)
maskt:  !byte $3f,$cf,$f3,$fc

; ported from the GKGM STARS data table (l007), mapped GM->multicolor:
;   mx = gmX - 12   (gmX 12..171 -> 0..159)
;   my = gmY - 50   (gmY 50..249 -> 0..199)
; stars 0-4 = layer1, 5-9 = layer2, 10-14 = layer3
starMX: !byte 47,51,70,76,22,51,153,11,69,95, 133,117,127,105,153,112,83,4,45,106, 73,83,20,142,113,154,5,146,127,4
initMY: !byte 173,50,102,93,82,118,70,159,163,115, 92,138,25,189,38,45,53,67,132,120, 80,107,148,85,178,167,133,98,134,14
starMY: !fill NSTARS            ; live Y (mutated), seeded from initMY

; runtime-built lookup tables
ylo:      !fill 200
yhi:      !fill 200
xoff_lo:  !fill 160
xoff_hi:  !fill 160
