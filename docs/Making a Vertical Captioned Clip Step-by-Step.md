# Making a Vertical Captioned Clip: Step-by-Step

A repeatable workflow for downloading an exact moment from a YouTube video in 4K, converting it to a vertical 1080×1920 clip, and adding styled captions. Work from your `LVIDS` folder. `add_captions.py` and the `fonts` folder should already be there from last time.

## Step 1: Pick the exact moment

Play the video on YouTube and note the start and end times. Add about a second of padding on each side so no words get cut off. Use `MM:SS`, or `H:MM:SS` for longer videos.

## Step 2: Set your variables

Open PowerShell and run this block, changing the four values. You only edit here, and every later command reuses them:

```powershell
cd "C:\Users\lkand\Documents\LVIDS"
$url   = "https://www.youtube.com/watch?v=VIDEO_ID"
$start = "42:38"
$end   = "43:18"
$name  = "clip3"
```

Use a new `$name` for each clip so files don't overwrite each other. Strip anything after the video ID in the URL, such as `&t=...`.

## Step 3: Download only that section in 4K

```powershell
yt-dlp -P "C:\Users\lkand\Documents\LVIDS" -o "${name}.%(ext)s" -f "bv*+ba/b" -S "res,fps" --merge-output-format mkv --download-sections "*${start}-${end}" --force-keyframes-at-cuts $url
```

- This creates `clip3.mkv`.
- `--force-keyframes-at-cuts` makes the cut points exact. It re-encodes the section, so it is slower, especially for 4K. If it takes too long, remove that flag and use about 3 seconds of padding instead.
- If the video is age-restricted, add `--cookies-from-browser firefox` (and be logged into YouTube in Firefox).

## Step 4: Convert to vertical 1080×1920

```powershell
ffmpeg -i "${name}.mkv" -vf "scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -c:a aac -b:a 256k "${name}_vertical.mp4"
```

This centers the landscape video on a black 9:16 canvas, like your example, and creates `clip3_vertical.mp4`. For higher resolution, change the numbers to `scale=2160:-2,pad=2160:3840`. The caption script scales to any size automatically.

## Step 5: Add the captions

```powershell
python -m uv run --python 3.12 --with faster-whisper add_captions.py "${name}_vertical.mp4"
```

- This creates `clip3_vertical_captioned.mp4` and a `clip3_vertical.ass` caption file.
- It runs on your CPU, so expect a minute or two per clip. The first run of each model size downloads it.

## Step 6: Check it and fix mistakes

Watch the whole result with sound, looking at spelling, timing and position. To fix a misheard word, open `clip3_vertical.ass` in Notepad, correct the text at the end of the `Dialogue:` lines, save, then re-burn without transcribing again:

```powershell
ffmpeg -i "${name}_vertical.mp4" -vf "ass=${name}_vertical.ass:fontsdir=fonts" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -c:a aac -b:a 256k "${name}_final.mp4"
```

## Step 7: Clean up (optional)

Your finished file is the `_captioned.mp4` (or `_final.mp4` if you re-burned). Keep `clip3.mkv` as the original, and delete the rest if you need space:

```powershell
Remove-Item "${name}_vertical.mp4"
```

## Adjusting the caption look

Add these options to the Step 5 command:

| Option | Effect |
| --- | --- |
| `--center 0.80` | Move captions lower (default 0.776) |
| `--size 120` | Smaller text (default 136) |
| `--max-words 1` | One word per line |
| `--pause 0.8` | Keep lines together through short pauses |
| `--model medium` | More accurate, but slower |

## Notes

- Always use quotes around `$url` and file names that contain spaces.
- This exact combined sequence has not been run on your PC. Each command is based on ones that worked for you or that were tested.
- The first clip's video had an odd start timestamp, so check the caption sync on the first few words. If they are off by a constant amount, an offset option can be added.
- Only download and repost video you have the rights to use.
