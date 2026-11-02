#!/usr/bin/env python3
"""Generate sounds/done.oga, the timer-finished chime.

Two soft bell tones (E5 then B5) built from a few decaying sine partials, so
the sound is our own and needs no third-party license. Needs ffmpeg (libvorbis)
to encode; writes a WAV first.
Usage: scripts/make-sound.py
"""
import math
import pathlib
import struct
import subprocess
import tempfile
import wave

RATE = 44100
LENGTH = 1.8  # seconds
NOTES = [(659.25, 0.00), (987.77, 0.22)]  # (Hz, start s)
# (frequency multiple, relative level, decay per second) for a bell-like timbre
PARTIALS = [(1.0, 1.0, 3.0), (2.0, 0.35, 5.0), (3.01, 0.12, 8.0), (4.2, 0.05, 11.0)]
PEAK = 0.45

root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'sounds' / 'done.oga'

samples = []
for i in range(int(RATE * LENGTH)):
    t = i / RATE
    v = 0.0
    for freq, start in NOTES:
        dt = t - start
        if dt < 0:
            continue
        attack = min(1.0, dt / 0.008)  # 8 ms fade-in, no click
        for mult, level, decay in PARTIALS:
            v += attack * level * math.exp(-decay * dt) * math.sin(2 * math.pi * freq * mult * dt)
    samples.append(v)

# Fade out the tail and normalise.
fade = int(RATE * 0.15)
for i in range(fade):
    samples[-1 - i] *= i / fade
scale = PEAK / max(abs(s) for s in samples)

with tempfile.TemporaryDirectory() as tmp:
    wav = pathlib.Path(tmp) / 'done.wav'
    with wave.open(str(wav), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(s * scale * 32767)) for s in samples))
    out.parent.mkdir(exist_ok=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(wav),
                    '-c:a', 'libvorbis', '-q:a', '4', '-f', 'ogg', str(out)], check=True)

print(f'wrote {out.relative_to(root)} ({out.stat().st_size} bytes)')
