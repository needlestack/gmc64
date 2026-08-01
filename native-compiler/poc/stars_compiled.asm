; auto-generated from STARS /PRG by compile-stars.mjs — do not edit
BITMAP  = $2000
ptr     = $fb
px      = $10
py      = $11
pbits   = $12
tmpval  = $14
tmpmask = $15
rt_gmx  = $16
rt_gmy  = $17
tmp     = $1c
scnbg   = $30
scnc1   = $31
scnc2   = $32
scnc3   = $33

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
        lda #$00
        sta $d01a
        jsr rt_init
  lda #0
  sta scnbg
  lda #11
  sta scnc1
  lda #12
  sta scnc2
  lda #15
  sta scnc3
  jsr rt_scene_show
  lda #0
  sta $40
LBL_6:
  lda $40
  sta $45
  lda $45
  clc
  adc #15
  sta $45
  ldx $45
  lda DATA,x
  sta $42
  ldx $40
  lda $42
  sta RAM,x
  lda $40
  clc
  adc #1
  sta $40
  lda $40
  cmp #15
  bcc NOSKIP_1
  jmp AFTER_1
NOSKIP_1:
  jmp LBL_6
AFTER_1:
LBL_1:
  lda #1
  sta $43
  lda #1
  sta $44
  lda #0
  sta $40
LBL_3:
  jsr LBL_2
  lda $40
  clc
  adc #1
  sta $40
  lda $40
  cmp #5
  bcc NOSKIP_2
  jmp AFTER_2
NOSKIP_2:
  jmp LBL_3
AFTER_2:
  lda #2
  sta $43
  lda #2
  sta $44
LBL_4:
  jsr LBL_2
  lda $40
  clc
  adc #1
  sta $40
  lda $40
  cmp #10
  bcc NOSKIP_3
  jmp AFTER_3
NOSKIP_3:
  jmp LBL_4
AFTER_3:
  lda #3
  sta $43
  lda #3
  sta $44
LBL_5:
  jsr LBL_2
  lda $40
  clc
  adc #1
  sta $40
  lda $40
  cmp #15
  bcc NOSKIP_4
  jmp AFTER_4
NOSKIP_4:
  jmp LBL_5
AFTER_4:
  jmp LBL_1
LBL_2:
  ldx $40
  lda DATA,x
  sta $41
  ldx $40
  lda RAM,x
  sta $42
  lda #0
  sta pbits
  lda $41
  sta rt_gmx
  lda $42
  sta rt_gmy
  jsr rt_plot
  lda $42
  clc
  adc $43
  sta $42
  lda $42
  cmp #250
  bcs IFBODY_5
  jmp ENDIF_5
IFBODY_5:
  lda $42
  sec
  sbc #200
  sta $42
ENDIF_5:
  ldx $40
  lda $42
  sta RAM,x
  lda $44
  sta pbits
  lda $41
  sta rt_gmx
  lda $42
  sta rt_gmy
  jsr rt_plot
  rts
LBL_7:
  jmp HALT_LOOP

; ===== runtime library =====
rt_init:
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

rt_scene_show:
        lda $dd00
        ora #$03
        sta $dd00
        lda #$3b
        sta $d011
        lda #$18
        sta $d016
        lda #$18
        sta $d018
        lda scnbg
        sta $d020
        sta $d021
        lda scnc1               ; screen matrix = (color1<<4)|color2
        asl
        asl
        asl
        asl
        sta tmp
        lda scnc2
        and #$0f
        ora tmp
        ldx #$00
sfill:  sta $0400,x
        sta $0500,x
        sta $0600,x
        sta $0700,x
        inx
        bne sfill
        lda scnc3               ; color RAM = color3
        ldx #$00
cfill:  sta $d800,x
        sta $d900,x
        sta $da00,x
        sta $db00,x
        inx
        bne cfill
        lda #<BITMAP            ; clear 8K bitmap
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
        rts

rt_plot:                        ; plot at GKGM coords (rt_gmx,rt_gmy) with pbits
        lda rt_gmx
        sec
        sbc #12                 ; GM x 12..171 -> mc 0..159
        sta px
        lda rt_gmy
        sec
        sbc #50                 ; GM y 50..249 -> mc 0..199
        sta py
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

HALT_LOOP: jmp HALT_LOOP

valtab: !byte $00,$40,$80,$c0
        !byte $00,$10,$20,$30
        !byte $00,$04,$08,$0c
        !byte $00,$01,$02,$03
maskt:  !byte $3f,$cf,$f3,$fc
DATA:   !byte 23,140,55,98,167,31,120,74,151,42,88,133,17,105,160,70,180,110,240,85,155,205,95,135,225,60,175,120,235,145
RAM:      !fill 256
ylo:      !fill 200
yhi:      !fill 200
xoff_lo:  !fill 160
xoff_hi:  !fill 160

