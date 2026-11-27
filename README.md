# png-squeeze — smallest lossless PNG for 1280×720 screenshots

Entry for make.fun bounty `png-squeeze-01-run-20261127` ("Squeeze screenshots into
the smallest PNG, 27 November 2026"). One program, `main.ts` (Node 22, built-in
modules only: `fs`, `path`, `zlib`), rewrites each 1280×720 RGBA screenshot in
`/input/<id>/image.png` as a lossless PNG in `/output/<id>/image.png`, as small
as it can, inside one 60-second wall budget for the whole set of 8.

## How it works

1. **Decode** the stored input PNG to RGBA (full PNG decoder: all five filters,
   colour types 0/2/3/4/6, PLTE/tRNS).
2. **Analyse** the pixels: opaque? grey? at most 256 distinct colours? one single
   fully-transparent value?
3. **Screen the lossless forms** that hold the image exactly, each weighed by zlib:
   - palette (colour type 3) when ≤ 256 colours, ordered by count and by luminance,
     transparent entries first so tRNS stays short;
   - grey (0) / grey+alpha (4) / RGB (2) / RGBA (6) otherwise, with a tRNS key when
     every non-opaque pixel shares one fully transparent value;
   - per-row filters: None, minimum-sum, fewest-distinct-pairs, and brute force
     (every filter of every row compressed by zlib against the 32 KiB written
     before it, smallest kept).
   The smallest form+filters by zlib level 6 wins.
4. **Final compression**: the winner's filtered data re-compressed with zlib
   level 9 (default and filtered strategies, smallest kept) and written as a
   single-IDAT PNG holding only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8,
   non-interlaced.

Everything is deterministic — no clock, no randomness, no environment reads
beyond the input/output directories — so two runs write byte-identical outputs.
The work is fixed per image, never cut off by time.

## Run locally (practice set from the kit)

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=practice/reference \
  MAKEFUN_SCORES_DIR=scores node program/scorer/score.ts
```

## Results on the practice set (local grade, 1 CPU, 31.7 s for the set of 8)

| instance | theme | bytes | points (of 1000) |
|----------|-------|-------|------------------|
| i001 | flat  | 12,496  | 718.370 |
| i002 | rich  | 51,852  | 705.539 |
| i003 | alpha | 106,556 | 674.922 |
| i004 | grey  | 103,945 | 706.331 |
| i005 | flat  | 16,552  | 742.251 |
| i006 | rich  | 178,169 | 692.304 |
| i007 | alpha | 60,890  | 701.871 |
| i008 | grey  | 24,897  | 714.158 |

**Total score: 706,968** (passed 8/8, all exact). House baseline `fixed-paeth 1.0.0`
scores 420,399 on the same practice set.

## License

MIT — see `LICENSE`.
