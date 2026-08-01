; smoke test: BASIC autostart stub + tiny ML that recolors the screen.
; Proves asm6502 + .prg packaging + VICE screenshot harness before we
; invest in the full starfield. Expect: red background, black border.

* = $0801
; BASIC:  10 SYS 2061
!byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00

entry:                 ; = $080d = 2061
        sei
        lda #$00       ; black
        sta $d020      ; border
        lda #$02       ; red
        sta $d021      ; background
loop:   jmp loop
