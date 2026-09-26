#!/usr/bin/env python3
"""Shiba-style steel-blue dither for blog hero images.

Usage: python3 scripts/zuse-dither.py <input.png> <output.png> [pixel_size] [palette]

Downscales, applies a 4x4 Bayer ordered dither, quantizes to the
steel-blue palette, and upscales with nearest neighbour for crisp
retro pixels. Requires numpy + Pillow.
"""
import sys
import numpy as np
from PIL import Image

PALETTES = {
    # Shiba steel-blue blog palette (matching #9cbce2 button and retro terminals)
    "steel-blue": np.array([
        [16, 18, 26],     # void
        [45, 62, 92],     # deep steel slate
        [156, 188, 226],  # steel blue (#9cbce2)
        [225, 238, 252],  # crisp ice white
    ], dtype=np.float32),
    # Legacy alias pointing to the steel-blue palette
    "violet-dusk": np.array([
        [16, 18, 26],
        [45, 62, 92],
        [156, 188, 226],
        [225, 238, 252],
    ], dtype=np.float32),
    # Shiba theme tokens (apps/web/src/styles/theme.css), light mode:
    # --paper --card --line --navy --ink
    "shiba-light": np.array([
        [246, 244, 237],
        [255, 254, 248],
        [224, 222, 213],
        [0, 0, 168],
        [34, 35, 32],
    ], dtype=np.float32),
    # Shiba theme tokens, dark mode:
    # --paper --card --line --navy --ink
    "shiba-dark": np.array([
        [25, 26, 24],
        [34, 35, 32],
        [59, 61, 54],
        [156, 188, 226],
        [234, 232, 225],
    ], dtype=np.float32),
}

# 4x4 Bayer matrix for ordered dithering
BAYER_4X4 = np.array([
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
], dtype=np.float32) / 16.0 - 0.5


def zuse_dither(input_path, output_path, pixel_size=2, strength=35.0,
                palette="steel-blue"):
    img = Image.open(input_path).convert("RGB")
    pal = PALETTES.get(palette, PALETTES["steel-blue"])

    small_w = max(1, img.width // pixel_size)
    small_h = max(1, img.height // pixel_size)
    img_small = img.resize((small_w, small_h), Image.Resampling.BILINEAR)

    arr = np.array(img_small, dtype=np.float32)
    h, w, _ = arr.shape

    tiled_bayer = np.tile(BAYER_4X4, (h // 4 + 1, w // 4 + 1))[:h, :w]
    tiled_bayer = tiled_bayer[:, :, np.newaxis]

    dithered = np.clip(arr + tiled_bayer * strength, 0, 255)

    diff = dithered[:, :, np.newaxis, :] - pal[np.newaxis, np.newaxis, :, :]
    dist = np.sum(diff ** 2, axis=-1)
    indices = np.argmin(dist, axis=-1)
    out_arr = pal[indices].astype(np.uint8)

    out_img = Image.fromarray(out_arr)
    out_img = out_img.resize(
        (small_w * pixel_size, small_h * pixel_size), Image.Resampling.NEAREST
    )
    out_img.save(output_path)
    print(f"Generated Shiba-style image: {output_path} (palette={palette})")


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    px = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    pal_name = sys.argv[4] if len(sys.argv) > 4 else "steel-blue"
    zuse_dither(src, dst, pixel_size=px, palette=pal_name)

