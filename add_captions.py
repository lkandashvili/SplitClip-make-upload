#!/usr/bin/env python3
"""
add_captions.py - burn "stacked red/white" word-by-word captions into a vertical video.

Style (measured from the reference clip, for a 1080x1920 frame):
  * ALL CAPS, very heavy font, no outline, no punctuation
  * 1-2 words per line, up to 2 lines per caption block
  * first line appears in RED with a small "pop"; when the second line appears
    (also red + pop), the first line turns WHITE
  * block is centred at ~77.6% of the frame height (inside the black area below the video)

Usage:
    python add_captions.py vertical.mp4
    python add_captions.py vertical.mp4 -o out.mp4 --size 70 --center 0.80

Requires: ffmpeg/ffprobe on PATH and  pip install faster-whisper
The font (Poppins ExtraBold) is downloaded once into a 'fonts' folder next to the video.
"""
import argparse
import subprocess
import sys
import urllib.request
from pathlib import Path

FONT_URL = ("https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/"
            "Poppins-ExtraBold.ttf")
STRIP = ".,;:!?\"'\u201c\u201d\u2018\u2019\u2026-\u2014()[]"


# ----------------------------------------------------------------- helpers
def ass_time(t):
    cs = int(round(max(t, 0.0) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_color(rrggbb):
    r, g, b = rrggbb[0:2], rrggbb[2:4], rrggbb[4:6]
    return f"&H00{b}{g}{r}&"


def probe_size(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        text=True).strip()
    w, h = out.split("x")
    return int(w), int(h)


def ensure_font(fonts_dir):
    fonts_dir.mkdir(exist_ok=True)
    if any(p.suffix.lower() in (".ttf", ".otf") for p in fonts_dir.iterdir()):
        return
    target = fonts_dir / "Poppins-ExtraBold.ttf"
    try:
        print("Downloading font (one time)...")
        urllib.request.urlretrieve(FONT_URL, target)
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING: could not download the font ({exc}).\n"
              f"Put a heavy .ttf font in {fonts_dir} or use --font Impact.")


# ----------------------------------------------------------- transcription
def load_audio(path):
    """Decode audio with ffmpeg to 16 kHz mono float32 (avoids faster-whisper's PyAV loader)."""
    import numpy as np
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn",
           "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
    raw = subprocess.run(cmd, check=True, stdout=subprocess.PIPE).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def transcribe(path, model_size, language, device="cpu"):
    from faster_whisper import WhisperModel
    print("Decoding audio with ffmpeg...")
    audio = load_audio(path)
    print(f"Loading Whisper model '{model_size}' (first run downloads it)...")
    compute = "int8" if device == "cpu" else "float16"
    print(f"Running Whisper on: {device}")
    model = WhisperModel(model_size, device=device, compute_type=compute)
    segments, info = model.transcribe(
        audio, word_timestamps=True, language=language, vad_filter=True)
    print(f"Detected language: {info.language}")
    words = []
    for seg in segments:
        for w in seg.words or []:
            if w.word.strip():
                words.append((w.start, w.end, w.word.strip()))
    return words


# ---------------------------------------------------------------- layout
def make_lines(words, max_words, max_chars, pause):
    """Words -> lines of 1..max_words words. 'hard' = the caption block must end here."""
    lines, cur = [], []

    def flush(hard):
        nonlocal cur
        if cur:
            lines.append({"words": cur, "hard": hard})
            cur = []

    for start, end, raw in words:
        text = raw.upper().strip(STRIP)
        if not text:
            continue
        if cur:
            gap = start - cur[-1][1]
            too_long = len(" ".join(x[2] for x in cur) + " " + text) > max_chars
            if gap > pause:
                flush(True)
            elif len(cur) >= max_words or too_long:
                flush(False)
        cur.append((start, end, text))
        if raw[-1:] in ".!?":
            flush(True)
    flush(True)
    return lines


def make_blocks(lines):
    blocks, cur = [], []
    for ln in lines:
        cur.append(ln)
        if ln["hard"] or len(cur) == 2:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    return blocks


def line_text(line):
    return " ".join(w[2] for w in line["words"])


def build_events(blocks, hold, y_center, pitch, max_chars):
    """-> list of (start, end, y, is_red, pop, text, fit_scale)"""
    ev = []

    def fit(text):
        return min(1.0, max_chars / max(len(text), 1))

    for i, b in enumerate(blocks):
        start = b[0]["words"][0][0]
        end = b[-1]["words"][-1][1] + hold
        if i + 1 < len(blocks):
            end = min(end, blocks[i + 1][0]["words"][0][0])
        end = max(end, start + 0.3)
        t1 = line_text(b[0])
        if len(b) == 1:
            ev.append((start, end, y_center, True, True, t1, fit(t1)))
            continue
        t2 = line_text(b[1])
        switch = min(max(b[1]["words"][0][0], start + 0.1), end - 0.05)
        y1, y2 = y_center - pitch / 2, y_center + pitch / 2
        ev.append((start, switch, y1, True, True, t1, fit(t1)))
        ev.append((switch, end, y1, False, False, t1, fit(t1)))
        ev.append((switch, end, y2, True, True, t2, fit(t2)))
    return ev


def build_ass(events, width, height, font, size, spacing, red, white, pop, space_spacing=None, outline=0.0):
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size:.1f},{ass_color(red)},{ass_color(red)},&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,{outline:.1f},0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rows = []
    for start, end, y, is_red, do_pop, text, fit_scale in events:
        tags = f"\\an5\\pos({width / 2:.0f},{y:.0f})\\fsp{spacing:.1f}"
        if not is_red:
            tags += f"\\1c{ass_color(white)}"
        if fit_scale < 1.0:
            tags += f"\\fscx{100 * fit_scale:.0f}\\fscy{100 * fit_scale:.0f}"
        if do_pop and pop:
            base = 100 * fit_scale
            tags += (f"\\fscx{base * 1.25:.0f}\\fscy{base * 1.25:.0f}"
                     f"\\t(0,150,\\fscx{base:.0f}\\fscy{base:.0f})")
        if space_spacing is not None:
            text = text.replace(" ", f"{{\\fsp{space_spacing:.1f}}} {{\\fsp{spacing:.1f}}}")
        rows.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,"
                    f"{{{tags}}}{text}")
    return header + "\n".join(rows) + "\n"


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description="Stacked red/white word-by-word captions")
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--language", default=None, help="e.g. en (auto if omitted)")
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"],
                    help="cpu (default, always works) or cuda (needs NVIDIA CUDA libraries)")
    ap.add_argument("--max-words", type=int, default=2, help="words per line")
    ap.add_argument("--max-chars", type=int, default=19, help="max characters per line")
    ap.add_argument("--pause", type=float, default=0.5, help="pause (s) that ends a block")
    ap.add_argument("--hold", type=float, default=0.15, help="seconds a block stays after its last word")
    ap.add_argument("--font", default="Poppins ExtraBold")
    ap.add_argument("--fontsdir", default="fonts", help="folder with .ttf files (next to the video)")
    ap.add_argument("--size", type=float, default=136, help="ASS font size at 1080 width (~54 px capital letters)")
    ap.add_argument("--spacing", type=float, default=-8, help="letter spacing px at 1080 width")
    ap.add_argument("--word-gap", type=float, default=4,
                    help="spacing after the space character, px at 1080 width (bigger = wider gap between words)")
    ap.add_argument("--pitch", type=float, default=76, help="line distance px at 1080 width")
    ap.add_argument("--center", type=float, default=0.776,
                    help="vertical centre of the caption block (fraction of frame height)")
    ap.add_argument("--y-adjust", type=float, default=8,
                    help="extra px to move captions down (+) or up (-) at 1080 width")
    ap.add_argument("--outline", type=float, default=0,
                    help="black outline thickness, px at 1080 width (about 6 helps over busy video)")
    ap.add_argument("--red", default="A70206")
    ap.add_argument("--white", default="FFFFFF")
    ap.add_argument("--no-pop", action="store_true")
    ap.add_argument("--crf", type=int, default=14)
    args = ap.parse_args()

    src = Path(args.input).resolve()
    if not src.exists():
        sys.exit(f"File not found: {src}")
    out = Path(args.output).resolve() if args.output else src.with_name(src.stem + "_captioned.mp4")

    width, height = probe_size(str(src))
    k = width / 1080.0
    fonts_dir = src.parent / args.fontsdir
    if args.font == "Poppins ExtraBold":
        ensure_font(fonts_dir)

    words = transcribe(str(src), args.model, args.language, args.device)
    if not words:
        sys.exit("No speech detected.")
    blocks = make_blocks(make_lines(words, args.max_words, args.max_chars, args.pause))
    events = build_events(blocks, args.hold,
                          y_center=height * args.center + args.y_adjust * k,
                          pitch=args.pitch * k, max_chars=args.max_chars)
    ass_path = src.with_suffix(".ass")
    ass_path.write_text(
        build_ass(events, width, height, args.font, args.size * k, args.spacing * k,
                  args.red, args.white, not args.no_pop, space_spacing=args.word_gap * k,
                  outline=args.outline * k),
        encoding="utf-8")
    print(f"{len(blocks)} caption blocks -> {ass_path}")

    vf = f"ass={ass_path.name}"
    if fonts_dir.exists():
        vf += f":fontsdir={args.fontsdir}"
    cmd = ["ffmpeg", "-y", "-i", src.name, "-vf", vf,
           "-c:v", "libx264", "-crf", str(args.crf), "-preset", "slow",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", str(out)]
    print("Burning captions with ffmpeg...")
    subprocess.run(cmd, check=True, cwd=str(src.parent))
    print(f"Done: {out}")


if __name__ == "__main__":
    main()
