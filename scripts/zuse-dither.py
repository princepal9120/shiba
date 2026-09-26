#!/usr/bin/env python3
"""Zuse-style "Violet dusk" dither for blog hero images.

Usage: python3 scripts/zuse-dither.py <input.png> <output.png> [pixel_size]

Downscales, applies a 4x4 Bayer ordered dither, quantizes to the
Violet-dusk palette, and upscales with nearest neighbour for crisp
retro pixels. Requires numpy + Pillow.
"""
import sys
import numpy as np
from PIL import Image

# Zuse's exact default palette ("Violet dusk")
PALETTE = np.array([
    [15, 13, 24],
    [61, 47, 91],
    [124, 99, 169],
    [217, 201, 239],
], dtype=np.float32)

# 4x4 Bayer matrix for ordered dithering
BAYER_4X4 = np.array([
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
], dtype=np.float32) / 16.0 - 0.5


def zuse_dither(input_path, output_path, pixel_size=2, strength=35.0):
    img = Image.open(input_path).convert("RGB")

    small_w = max(1, img.width // pixel_size)
    small_h = max(1, img.height // pixel_size)
    img_small = img.resize((small_w, small_h), Image.Resampling.BILINEAR)

    arr = np.array(img_small, dtype=np.float32)
    h, w, _ = arr.shape

    tiled_bayer = np.tile(BAYER_4X4, (h // 4 + 1, w // 4 + 1))[:h, :w]
    tiled_bayer = tiled_bayer[:, :, np.newaxis]

    dithered = np.clip(arr + tiled_bayer * strength, 0, 255)

    diff = dithered[:, :, np.newaxis, :] - PALETTE[np.newaxis, np.newaxis, :, :]
    dist = np.sum(diff ** 2, axis=-1)
    indices = np.argmin(dist, axis=-1)
    out_arr = PALETTE[indices].astype(np.uint8)

    out_img = Image.fromarray(out_arr)
    out_img = out_img.resize(
        (small_w * pixel_size, small_h * pixel_size), Image.Resampling.NEAREST
    )
    out_img.save(output_path)
    print(f"Generated Zuse-style image: {output_path}")


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    px = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    zuse_dither(src, dst, pixel_size=px)
