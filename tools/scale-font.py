#!/usr/bin/env python3
"""
Scale a font horizontally to correct C64 pixel aspect ratio.
C64 pixels are taller than wide, so on modern square-pixel displays
the font appears stretched. This script compresses it horizontally.
"""

from fontTools.ttLib import TTFont
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
import sys
import os

SCALE_X = 0.85  # Horizontal scale factor

# Per-glyph lsb adjustments (negative = shift left, positive = shift right)
LSB_ADJUSTMENTS = {
    'u': -120,  # too far right, shift left more
    'd': -40,   # touch too far right
    'e': 40,    # bit too far left, shift right
}

def scale_font(input_path, output_path):
    print(f"Loading {input_path}...")
    font = TTFont(input_path)

    # For monospace fonts, find the common advance width and scale it once
    if 'hmtx' in font:
        hmtx = font['hmtx']
        # Get the first non-zero width as the monospace width
        mono_width = None
        for glyph_name in hmtx.metrics:
            width, lsb = hmtx.metrics[glyph_name]
            if width > 0:
                mono_width = width
                break

        if mono_width:
            new_mono_width = int(mono_width * SCALE_X)
            print(f"Original monospace width: {mono_width}, scaled: {new_mono_width}")

            # Apply uniform width to all glyphs, recalculate lsb to center glyph
            for glyph_name in hmtx.metrics:
                old_width, old_lsb = hmtx.metrics[glyph_name]
                if old_width > 0:
                    # Scale the lsb proportionally but keep glyph centered
                    # New lsb = old_lsb * scale (keeps glyph in same relative position)
                    new_lsb = int(old_lsb * SCALE_X)
                    # Apply per-glyph adjustments
                    if glyph_name in LSB_ADJUSTMENTS:
                        new_lsb += LSB_ADJUSTMENTS[glyph_name]
                        print(f"Adjusted '{glyph_name}' lsb by {LSB_ADJUSTMENTS[glyph_name]}")
                    hmtx.metrics[glyph_name] = (new_mono_width, new_lsb)
                else:
                    # Zero-width glyphs (like space might be handled differently)
                    hmtx.metrics[glyph_name] = (new_mono_width, 0)

    # Scale the glyph outlines if present (for outline fonts)
    if 'glyf' in font:
        glyf = font['glyf']
        for glyph_name in glyf.keys():
            glyph = glyf[glyph_name]
            # Get per-glyph shift amount (same as lsb adjustment)
            shift_x = LSB_ADJUSTMENTS.get(glyph_name, 0)
            if glyph.numberOfContours > 0:
                # Scale x coordinates, then apply per-glyph shift
                for i, coord in enumerate(glyph.coordinates):
                    new_x = int(coord[0] * SCALE_X) + shift_x
                    glyph.coordinates[i] = (new_x, coord[1])
            if hasattr(glyph, 'xMin') and glyph.xMin is not None:
                glyph.xMin = int(glyph.xMin * SCALE_X) + shift_x
                glyph.xMax = int(glyph.xMax * SCALE_X) + shift_x

    # Scale CFF outlines if present (for CFF/OTF fonts)
    if 'CFF ' in font:
        cff = font['CFF ']
        for fontDict in cff.cff.topDictIndex:
            if hasattr(fontDict, 'CharStrings'):
                charstrings = fontDict.CharStrings
                for glyph_name in charstrings.keys():
                    cs = charstrings[glyph_name]
                    # CFF charstrings need special handling
                    # For bitmap fonts this may not apply

    # Update units per em related values if needed
    # (Usually not necessary for simple scaling)

    # Scale OS/2 metrics
    if 'OS/2' in font:
        os2 = font['OS/2']
        if hasattr(os2, 'xAvgCharWidth'):
            os2.xAvgCharWidth = int(os2.xAvgCharWidth * SCALE_X)

    # Scale head table bounding box
    if 'head' in font:
        head = font['head']
        head.xMin = int(head.xMin * SCALE_X)
        head.xMax = int(head.xMax * SCALE_X)

    # Scale hhea metrics
    if 'hhea' in font:
        hhea = font['hhea']
        if hasattr(hhea, 'advanceWidthMax'):
            hhea.advanceWidthMax = int(hhea.advanceWidthMax * SCALE_X)
        if hasattr(hhea, 'minLeftSideBearing'):
            hhea.minLeftSideBearing = int(hhea.minLeftSideBearing * SCALE_X)
        if hasattr(hhea, 'minRightSideBearing'):
            hhea.minRightSideBearing = int(hhea.minRightSideBearing * SCALE_X)
        if hasattr(hhea, 'xMaxExtent'):
            hhea.xMaxExtent = int(hhea.xMaxExtent * SCALE_X)

    print(f"Saving {output_path}...")
    font.save(output_path)
    print(f"Done! Scaled font saved to {output_path}")

if __name__ == '__main__':
    input_file = '../css/fonts/C64_Pro_Mono-STYLE.woff2'
    output_file = '../css/fonts/C64_Pro_Mono_Narrow.woff2'

    # Resolve paths relative to script location
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(script_dir, input_file)
    output_path = os.path.join(script_dir, output_file)

    scale_font(input_path, output_path)
