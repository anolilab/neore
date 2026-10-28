"""Dictation spike benchmark (plans/desktop-dictation.md S1): run whisper.cpp models over the
fixed clips and report size, time, peak memory, CPU and accuracy (word error rate, or
character error rate for ja/zh).

The clips are prompts read by synthetic voices, one per supported language
(prompts.tsv: language, voice, reference text), plus 00-en-10s, exactly ten seconds.

Usage: python3 -I bench.py <whisper-cli> <models-dir> <clips-dir> <prompts.tsv> [model ...]
"""

import json
import os
import platform
import signal
import re
import subprocess
import sys
import threading
import time

# A recogniser that hangs must not hold the whole job until its timeout and lose every result.
CLIP_TIMEOUT_S = 900
import unicodedata

CHAR_LANGS = {"ja", "zh"}


def normalise(text, lang):
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[^\w\s]", " ", text)
    if lang in CHAR_LANGS:
        return [c for c in text if not c.isspace()]
    return text.split()


def edit_distance(ref, hyp):
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def _run_measured_windows(cmd):
    import psutil  # Windows has no /usr/bin/time; the workflow installs psutil there.

    start = time.monotonic()
    proc = psutil.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    # Drain both pipes while sampling, or a chatty recogniser blocks on a full pipe and never exits.
    output = {}
    reader = threading.Thread(target=lambda: output.update(zip(("out", "err"), proc.communicate())))
    reader.start()
    peak = cpu = 0.0

    def sample():
        nonlocal peak, cpu
        try:
            peak = max(peak, proc.memory_info().peak_wset / 1048576)
            times = proc.cpu_times()
            cpu = max(cpu, times.user + times.system)
        except psutil.Error:
            pass

    while proc.poll() is None:
        if time.monotonic() - start > CLIP_TIMEOUT_S:
            proc.kill()
            proc.wait()
            break
        sample()
        time.sleep(0.02)
    # The exited process's handle stays open until it is reaped, so one last sample still counts its final work.
    sample()
    reader.join()
    return output.get("out") or "", time.monotonic() - start, peak, cpu, proc.returncode


def peak_rss_and_cpu(cmd):
    """Runs cmd under /usr/bin/time; returns (stdout, wall seconds, peak RSS MiB, cpu seconds)."""
    if platform.system() == "Windows":
        return _run_measured_windows(cmd)
    is_mac = platform.system() == "Darwin"
    timer = ["/usr/bin/time", "-l"] if is_mac else ["/usr/bin/time", "-v"]
    start = time.monotonic()
    # Its own process group, so a timeout ends the recogniser too and not only /usr/bin/time,
    # whose orphaned child would keep the pipes open.
    proc = subprocess.Popen(timer + cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace", start_new_session=True)
    try:
        out, err = proc.communicate(timeout=CLIP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return "", time.monotonic() - start, None, None, -1
    proc = subprocess.CompletedProcess(proc.args, proc.returncode, out, err)
    wall = time.monotonic() - start
    err = proc.stderr
    rss = cpu = None
    if is_mac:
        m = re.search(r"(\d+)\s+maximum resident set size", err)
        rss = int(m.group(1)) / 1048576 if m else None
        u = re.search(r"([\d.]+)\s+user", err)
        s = re.search(r"([\d.]+)\s+sys", err)
        cpu = float(u.group(1)) + float(s.group(1)) if u and s else None
    else:
        m = re.search(r"Maximum resident set size \(kbytes\): (\d+)", err)
        rss = int(m.group(1)) / 1024 if m else None
        u = re.search(r"User time \(seconds\): ([\d.]+)", err)
        s = re.search(r"System time \(seconds\): ([\d.]+)", err)
        cpu = float(u.group(1)) + float(s.group(1)) if u and s else None
    return proc.stdout, wall, rss, cpu, proc.returncode


# Extra recogniser flags for one platform, e.g. `-ng` (no GPU) where the GPU backend is virtual.
EXTRA_ARGS = os.environ.get("WHISPER_ARGS", "").split()


def main():
    # whisper.cpp writes UTF-8; Windows would otherwise decode and print in its ANSI code page.
    sys.stdout.reconfigure(encoding="utf-8")
    cli, models_dir, clips_dir, prompts_path = sys.argv[1:5]
    models = sys.argv[5:] or ["tiny", "base", "small"]
    prompts = [line.rstrip("\n").split("\t") for line in open(prompts_path, encoding="utf-8") if line.strip()]
    clips = sorted(f for f in os.listdir(clips_dir) if f.endswith((".flac", ".wav")) and not f.startswith("00-"))
    # Clip NN-<lang> is prompt row NN; pair by name, never by position, so a missing or extra clip fails loudly.
    if len(clips) != len(prompts):
        sys.exit(f"{len(clips)} clips for {len(prompts)} prompts")
    for index, (clip, (lang, _voice, _text)) in enumerate(zip(clips, prompts), 1):
        if not clip.startswith(f"{index:02d}-{lang}."):
            sys.exit(f"clip {clip} does not match prompt row {index} ({lang})")
    results = []
    for model in models:
        path = os.path.join(models_dir, f"ggml-{model}.bin")
        size_mb = os.path.getsize(path) / 1e6
        errors = total = 0
        per_lang = {}
        walls, rsss, cpus = [], [], []
        empty = 0
        for clip, (lang, _voice, text) in zip(clips, prompts):
            out, wall, rss, cpu, code = peak_rss_and_cpu([cli, "-m", path, "-f", os.path.join(clips_dir, clip), "-l", lang, "-nt", "-np", "-t", "4", *EXTRA_ARGS])
            if code != 0:
                sys.exit(f"{model} failed on {clip} (exit {code})")
            ref, hyp = normalise(text, lang), normalise(out, lang)
            # A backend that cannot run the model can exit 0 with no text; count it so the report shows it.
            empty += not hyp
            err = edit_distance(ref, hyp)
            errors += err
            total += len(ref)
            pl = per_lang.setdefault(lang, [0, 0])
            pl[0] += err
            pl[1] += len(ref)
            walls.append(wall)
            rsss.append(rss or 0)
            cpus.append(cpu or 0)
        # The speed figure is for ONE known clip: a second match or a renamed file must stop the run, not pick whichever comes first.
        controls = [f for f in os.listdir(clips_dir) if f.startswith("00-en-10s")]
        if controls != ["00-en-10s.flac"]:
            sys.exit(f"expected exactly 00-en-10s.flac as the control clip; found {controls}")
        ten = os.path.join(clips_dir, controls[0])
        ten_out, ten_wall, ten_rss, ten_cpu, code = peak_rss_and_cpu([cli, "-m", path, "-f", ten, "-l", "en", "-nt", "-np", "-t", "4", *EXTRA_ARGS])
        if code != 0:
            sys.exit(f"{model} failed on the ten-second clip (exit {code})")
        # A run that produced no text did no recognition, so its time says nothing about the model.
        ten_empty = not normalise(ten_out, "en")
        results.append(
            {
                "model": model,
                "size_mb": round(size_mb, 1),
                # Word error rate for most languages, character error rate for ja/zh: the pooled figure mixes
                # units, so the comparable score is the mean of the per-language rates.
                "mean_lang_error": round(sum(v[0] / v[1] for v in per_lang.values()) / len(per_lang), 3),
                "pooled_error": round(errors / total, 3),
                "per_lang_error": {k: round(v[0] / v[1], 3) for k, v in per_lang.items()},
                "ten_second_clip_s": round(ten_wall, 2),
                "ten_second_cpu_s": round(ten_cpu or 0, 2),
                "peak_rss_mb": round(max(rsss + [ten_rss or 0]), 0),
                "mean_clip_s": round(sum(walls) / len(walls), 2),
                "empty_transcripts": empty,
                "ten_second_clip_empty": ten_empty,
            }
        )
    print(json.dumps({"platform": f"{platform.system()} {platform.machine()}", "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
