"""Builds media/tidemark-demo.mp4: title slides + dashboard screenshots with Windows TTS narration.

Usage: python media/make_video.py <folder with g1-brief-tickets.png, g2-signals.png, g3-guardrails.png>
Needs: Pillow, imageio-ffmpeg, Windows (System.Speech).
"""
import subprocess
import sys
import wave
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
SHOTS = Path(sys.argv[1])
WORK = HERE / "video-work"
WORK.mkdir(exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

BG, INK, MUTED, BRAND = (14, 20, 18), (230, 236, 233), (147, 162, 156), (45, 212, 191)


def font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def slide(n, title, lines, kicker="TIDEMARK"):
    im = Image.new("RGB", (1920, 1080), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([140, 120, 200, 180], radius=14, fill=BRAND)
    d.text((230, 128), kicker, font=font(34, True), fill=BRAND)
    d.text((140, 230), title, font=font(78, True), fill=INK)
    y = 400
    for line in lines:
        bullet = not line.startswith("  ")
        text = line.strip()
        if bullet:
            d.ellipse([150, y + 22, 166, y + 38], fill=BRAND)
        d.text((190, y), text, font=font(44), fill=INK if bullet else MUTED)
        y += 78
    p = WORK / f"slide-{n:02d}.png"
    im.save(p)
    return p


S1 = slide(1, "An agentic one-person crypto desk", [
    "SoSoValue data in",
    "Explained BUY / SELL / HOLD signals out",
    "Order tickets priced on live SoDEX books",
    "A human confirms every ticket",
], kicker="TIDEMARK  ·  SoSoValue Buildathon, Wave 3")
S2 = slide(2, "The problem", [
    "A solo trader has the data and the venue, but no desk",
    "Nobody turns ETF flows, news and macro into a decision",
    "Nobody sizes it or checks execution cost before the click",
    "Tidemark does, every 6 hours, and shows its evidence",
])
S3 = slide(3, "Data → insight → action", [
    "Collect: ETF flows, coin & SSI snapshots, sectors, news, macro, FOMC",
    "Score: flows, momentum, sector, news, regime (each −1…+1)",
    "Decide: confidence rewards agreement, shrinks before macro events",
    "Size: 1% risk budget, volatility stops, exposure caps",
    "Price: walk the live SoDEX order book (spread, slippage, depth)",
    "Confirm: human in the loop + paper track record",
])
S4 = slide(4, "Risk controls", [
    "1% of equity at risk per idea, stops 2–12% from the daily range",
    "Max 20% per position, 60% gross exposure",
    "No shorts on spot, no ticket without a SoDEX market",
    "New longs paused when macro risk > 75%",
    "Ticket blocked above 30 bps slippage or below 98% fillable",
])
S5 = slide(5, "Built to run unattended", [
    "Node.js, no dependencies, 21 unit tests",
    "GitHub Actions: CI on every push + agent run every 6 hours",
    "API key in a repository secret, never in the page",
    "Static dashboard on GitHub Pages reads the published snapshot",
])
S6 = slide(6, "Try it", [
    "Live demo: emilpz320-a11y.github.io/tidemark-sosovalue",
    "Code: github.com/emilpz320-a11y/tidemark-sosovalue",
    "Research tool, not financial advice. Thank you!",
])

D = lambda name: SHOTS / name
SEGMENTS = [
    (S1, "Tidemark is an agentic, one-person crypto desk. It reads SoSoValue data, explains every signal, and turns the actionable ones into order tickets priced against live SoDEX order books. A human confirms every ticket."),
    (S2, "A solo trader has the data and the venue, but not a desk. Nobody turns ETF flows, news and macro into a decision, sizes it, or checks the execution cost before the click. Tidemark does that every six hours, and shows its evidence."),
    (S3, "The pipeline has six steps. Collect data from about twenty SoSoValue endpoints. Score five explainable factors. Decide buy, sell or hold, with a confidence that rewards agreement between factors and shrinks before macro events. Size the position from a risk budget. Price it by walking the live SoDEX book. And wait for a human to confirm."),
    (D("g1-brief-tickets.png"), "This is the live dashboard. The desk brief gives the regime, the macro calendar and the top idea. Below, the tickets: here, two short tickets on Bitcoin and Ethereum perpetuals, each with estimated fill, spread and slippage from the real order book, the stop, and the maximum loss. Confirm records a paper fill; nothing is sent."),
    (D("g2-signals.png"), "Every asset gets a card: the stance, the composite score, the confidence, and a bar for each factor. The explanation names the strongest drivers and what would change the view, and the news evidence links to the original articles. Spot markets cannot be shorted, so those sell calls are blocked with the reason shown."),
    (S4, "Risk is built in. One percent of equity at risk per idea, volatility based stops, position and gross exposure caps, no shorts on spot, new longs paused before major macro events, and tickets blocked when the book is too thin or slippage is too high."),
    (D("g3-guardrails.png"), "A paper track record marks every proposed ticket to the current SoDEX price, and a personal blotter keeps the tickets you confirmed. The guardrails panel shows macro risk, the next FOMC odds and the sizing rules."),
    (S5, "It runs unattended. Node with no dependencies and twenty one unit tests, GitHub Actions for continuous integration and a scheduled agent run every six hours, the API key kept as a repository secret, and a static dashboard on GitHub Pages."),
    (S6, "Try the live demo and read the code on GitHub. Thank you."),
]


def tts(text: str, out: Path) -> float:
    out.with_suffix(".txt").write_text(text, encoding="utf-8")
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}; $s.Rate = 0; "
        f"$s.SetOutputToWaveFile('{out}'); "
        f"$s.Speak([IO.File]::ReadAllText('{out.with_suffix('.txt')}')); $s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    with wave.open(str(out)) as w:
        return w.getnframes() / w.getframerate()


parts = []
for i, (img, text) in enumerate(SEGMENTS):
    wav = WORK / f"seg{i:02d}.wav"
    dur = tts(text, wav) + 0.8
    mp4 = WORK / f"seg{i:02d}.mp4"
    vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0e1412,format=yuv420p"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", str(img), "-i", str(wav),
                    "-af", "apad", "-t", f"{dur:.2f}", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "23",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", str(mp4)], check=True)
    parts.append(mp4)
    print(f"segment {i}: {dur:.1f}s")

listing = WORK / "list.txt"
listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
out = HERE / "tidemark-demo.mp4"
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(out)], check=True)
print("wrote", out)
