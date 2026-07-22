; ============================================================================
; STARSBENCH — native starfield + live "updates per frame" readout.
;
; Renders one real parallax pass per frame (smooth field), then fills the rest
; of the frame with in-place passes to measure how many star-updates the native
; code can sustain per frame.  Prints that number (top-left) as decimal.
; A raster IRQ at line 250 provides the frame tick.
;
; GKGM STARS managed ~4-5 star-updates per frame; this reports the native count.
; Built with GMC64's asm6502.mjs.
; ============================================================================

BITMAP  = $2000
SCREEN  = $0400
COLRAM  = $D800

ptr     = $fb
px      = $10
py      = $11
pbits   = $12
tmpval  = $14
tmpmask = $15
si      = $16
lcount  = $17
lspeed  = $18
lbits   = $19
upd     = $1a
tmp     = $1c
frameflag = $20
framecnt  = $21        ; $21/$22
updcnt    = $23        ; $23/$24  updates counted this frame
val       = $25        ; $25/$26  bin2dec working value
digit     = $27
dcol      = $28        ; digit cell column
place     = $29        ; printnum place index 0..4

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00

entry:
        sei
        lda #$00
        sta $d01a
        lda $dd00
        ora #$03
        sta $dd00
        lda #$3b
        sta $d011
        lda #$18
        sta $d016
        lda #$18
        sta $d018
        lda #$00
        sta $d020
        sta $d021

        lda #$bc
        ldx #$00
fillsc: sta SCREEN,x
        sta SCREEN+$100,x
        sta SCREEN+$200,x
        sta SCREEN+$300,x
        inx
        bne fillsc

        lda #$0f
        ldx #$00
fillcr: sta COLRAM,x
        sta COLRAM+$100,x
        sta COLRAM+$200,x
        sta COLRAM+$300,x
        inx
        bne fillcr

        lda #<BITMAP
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldx #$20
        lda #$00
clrpg:  ldy #$00
clrby:  sta (ptr),y
        iny
        bne clrby
        inc ptr+1
        dex
        bne clrpg

        jsr build_tables

        ldx #$00
seedy:  lda initMY,x
        sta starMY,x
        inx
        cpx #NSTARS
        bne seedy

        ; --- install raster IRQ at line 250 (frame tick) ---
        lda #$7f
        sta $dc0d               ; disable CIA1 timer IRQs
        lda $dc0d
        lda #$01
        sta $d01a               ; enable raster IRQ
        lda #250
        sta $d012
        lda $d011
        and #$7f
        sta $d011
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        lda #$ff
        sta $d019
        lda #$00
        sta frameflag
        cli

; ---------------------------------------------------------------------------
main:
        lda #$00
        sta frameflag
wf:     lda frameflag           ; align to a fresh frame
        beq wf

        lda #$00
        sta frameflag
        sta updcnt
        sta updcnt+1

        jsr pass_move           ; one real pass: stars advance
        jsr add15

fillp:  lda frameflag           ; spend the rest of the frame measuring
        bne filldone
        jsr pass_still          ; in-place pass (same cost, no net move)
        jsr add15
        jmp fillp
filldone:
        lda updcnt
        sta val
        lda updcnt+1
        sta val+1
        jsr printnum            ; show updates-this-frame
        jmp main

; ---------------------------------------------------------------------------
irq:
        lda #$01
        sta $d019               ; ack raster IRQ
        sta frameflag
        inc framecnt
        bne irqx
        inc framecnt+1
irqx:   jmp $ea81               ; KERNAL: restore regs & RTI

; ---------------------------------------------------------------------------
add15:  lda updcnt
        clc
        adc #15
        sta updcnt
        lda updcnt+1
        adc #$00
        sta updcnt+1
        rts

pass_move:
        lda #$00
        sta si
        lda #5
        sta lcount
        lda #1
        sta lspeed
        sta lbits
        jsr do_layer
        lda #5
        sta lcount
        lda #2
        sta lspeed
        sta lbits
        jsr do_layer
        lda #5
        sta lcount
        lda #3
        sta lspeed
        sta lbits
        jsr do_layer
        rts

pass_still:
        lda #$00
        sta si
        lda #5
        sta lcount
        lda #0
        sta lspeed
        lda #1
        sta lbits
        jsr do_layer
        lda #5
        sta lcount
        lda #0
        sta lspeed
        lda #2
        sta lbits
        jsr do_layer
        lda #5
        sta lcount
        lda #0
        sta lspeed
        lda #3
        sta lbits
        jsr do_layer
        rts

; ---------------------------------------------------------------------------
do_layer:
dl_lp:  ldx si
        lda starMX,x
        sta px
        lda starMY,x
        sta py
        lda #$00
        sta pbits
        jsr plotdot
        ldx si
        lda starMY,x
        clc
        adc lspeed
        cmp #200
        bcc dl_now
        sbc #200
dl_now: sta starMY,x
        sta py
        lda lbits
        sta pbits
        jsr plotdot
        inc si
        dec lcount
        bne dl_lp
        rts

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
        lda px
        and #$03
        asl
        asl
        ora pbits
        tax
        lda valtab,x
        sta tmpval
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
; printnum: render val (16-bit) as 5 decimal digits at top-left of the bitmap.
; ---------------------------------------------------------------------------
printnum:
        lda #$00
        sta place
pn_lp:  ldx place
        lda #$00
        sta digit
pn_sub: lda val+1               ; while val >= pow[place]
        cmp powhi,x
        bcc pn_done
        bne pn_do
        lda val
        cmp powlo,x
        bcc pn_done
pn_do:  sec                     ; val -= pow[place]
        lda val
        sbc powlo,x
        sta val
        lda val+1
        sbc powhi,x
        sta val+1
        inc digit
        ldx place
        jmp pn_sub
pn_done:
        lda place               ; cell column = place*2
        asl
        sta dcol
        lda digit
        jsr plotdigit
        inc place
        lda place
        cmp #5
        bne pn_lp
        rts

; plotdigit: draw digit (A) at bitmap cell column dcol, cell-row 0.
;   each glyph byte -> 2 bytes via expand[] (each bit -> bit-pair 11=gray3)
plotdigit:
        asl                     ; digit*8 -> font offset
        asl
        asl
        clc
        adc #<digitfont
        sta ptr
        lda #$00
        adc #>digitfont
        sta ptr+1
        ; dest low byte = dcol*8 (+row); hi = >BITMAP
        lda dcol
        asl
        asl
        asl                     ; dcol*8
        sta tmp                 ; dest offset base within first cell-row
        ldy #$00                ; glyph row
pd_row: lda (ptr),y             ; glyph byte
        pha
        lsr
        lsr
        lsr
        lsr                     ; hi nibble
        tax
        lda expand,x            ; left 2 bytes... left byte
        sta tmpval
        pla
        and #$0f
        tax
        lda expand,x            ; right byte
        sta tmpmask
        ; write left byte at BITMAP + tmp + y
        tya
        clc
        adc tmp
        tax                     ; X = dcol*8 + row (<= 71)
        lda tmpval
        sta BITMAP,x
        lda tmpmask
        sta BITMAP+8,x          ; next cell column (8 bytes over)
        iny
        cpy #$08
        bne pd_row
        rts

; ---------------------------------------------------------------------------
build_tables:
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
        beq bycell
        clc
        lda ptr
        adc #$01
        sta ptr
        lda ptr+1
        adc #$00
        sta ptr+1
        jmp bynext
bycell: clc
        lda ptr
        adc #<313
        sta ptr
        lda ptr+1
        adc #>313
        sta ptr+1
bynext: inx
        cpx #200
        bne byrow

        ldx #$00
bxlp:   txa
        lsr
        lsr
        sta tmp
        lda #$00
        sta tmp+1
        asl tmp
        rol tmp+1
        asl tmp
        rol tmp+1
        asl tmp
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
NSTARS  = 15

valtab: !byte $00,$40,$80,$c0
        !byte $00,$10,$20,$30
        !byte $00,$04,$08,$0c
        !byte $00,$01,$02,$03
maskt:  !byte $3f,$cf,$f3,$fc
expand: !byte $00,$03,$0c,$0f,$30,$33,$3c,$3f,$c0,$c3,$cc,$cf,$f0,$f3,$fc,$ff
powlo:  !byte <10000,<1000,<100,<10,<1
powhi:  !byte >10000,>1000,>100,>10,>1

digitfont:
        !byte $3c,$66,$6e,$76,$66,$66,$3c,$00   ; 0
        !byte $18,$38,$18,$18,$18,$18,$7e,$00   ; 1
        !byte $3c,$66,$06,$0c,$30,$60,$7e,$00   ; 2
        !byte $3c,$66,$06,$1c,$06,$66,$3c,$00   ; 3
        !byte $06,$0e,$1e,$66,$7f,$06,$06,$00   ; 4
        !byte $7e,$60,$7c,$06,$06,$66,$3c,$00   ; 5
        !byte $3c,$66,$60,$7c,$66,$66,$3c,$00   ; 6
        !byte $7e,$66,$0c,$18,$18,$18,$18,$00   ; 7
        !byte $3c,$66,$66,$3c,$66,$66,$3c,$00   ; 8
        !byte $3c,$66,$66,$3e,$06,$66,$3c,$00   ; 9

starMX: !byte 11,128,43,86,155, 19,108,62,139,30, 76,121,5,93,148
initMY: !byte 20,130,60,190,35, 105,155,45,85,175, 10,125,70,185,95
starMY: !fill NSTARS

ylo:      !fill 200
yhi:      !fill 200
xoff_lo:  !fill 160
xoff_hi:  !fill 160
