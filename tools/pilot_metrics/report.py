"""Pilot gate report and labelling sheet (GURU-39). Run from the project root inside the venv:

    source venv/bin/activate && python tools/pilot_metrics/report.py --start 2026-12-01 --r2 \\
        --sheet-out tools/pilot_metrics/data/sheet.csv --out tools/pilot_metrics/data/report.md
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

import metrics
import sheet

DEFAULT_SOURCE = Path(__file__).resolve().parent / "data" / "uploads"


def sync_r2(dest: Path) -> None:
    """Copy the bucket's uploads/ prefix into `dest`, skipping files already there."""
    try:
        import boto3
    except ImportError:
        sys.exit("--r2 needs boto3: pip install boto3 (inside the venv)")
    missing = [v for v in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(v)]
    if missing:
        sys.exit(f"--r2 needs {', '.join(missing)} in the environment")
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    bucket = os.environ.get("R2_BUCKET", "guru-uploads")
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="uploads/"):
        for obj in page.get("Contents", []):
            target = dest / obj["Key"].removeprefix("uploads/")
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                s3.download_file(bucket, obj["Key"], str(target))


def load(source: Path) -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(source.glob("*/*/*/summary.json"))]


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1%}"


def render(result: dict, start: date, sessions: int) -> str:
    lines = [
        "# GuruAI pilot gate report",
        "",
        f"Pilot start {start.isoformat()}; {sessions} session summaries. Only answers decided by Shekru count "
        "towards false praise and next-day revision; tapped answers are listed apart.",
    ]
    for week, targets in result.items():
        lines += ["", f"## Week {week}", "", "| Target | Value | Goal | Result | Sample |", "|---|---|---|---|---|"]
        for key, r in targets.items():
            label, kind, goal = metrics.TARGETS[key]
            result_text = "n/a" if r["passed"] is None else ("pass" if r["passed"] else "fail")
            sample = f"{r['hits']} of {r['n']}" + (f"; {r['tap']} tapped, excluded" if "tap" in r else "")
            bound = "at least" if kind == "min" else "at most"
            lines.append(f"| {label} | {pct(r['value'])} | {bound} {goal}% | {result_text} | {sample} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Pilot gate metrics per pilot week, and the hand-labelling sheet.")
    p.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                   help="local copy of the bucket's uploads/ prefix (default: tools/pilot_metrics/data/uploads)")
    p.add_argument("--start", type=date.fromisoformat, required=True, help="pilot start date, YYYY-MM-DD")
    p.add_argument("--labels", type=Path, help="a filled labelling sheet to read human labels from")
    p.add_argument("--sheet-out", type=Path, help="write the labelling sheet (CSV) here")
    p.add_argument("--out", type=Path, help="write the Markdown report here (default: stdout)")
    p.add_argument("--r2", action="store_true",
                   help="first copy new files from the R2 bucket into --source; needs R2_ACCOUNT_ID, "
                        "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (R2_BUCKET defaults to guru-uploads)")
    args = p.parse_args(argv)

    if args.r2:
        sync_r2(args.source)
    summaries = load(args.source)
    labels = sheet.read_labels(args.labels) if args.labels else {}

    if args.sheet_out:
        sheet.write(args.sheet_out, sheet.rows(summaries, labels))
    text = render(metrics.compute(summaries, args.start, labels), args.start, len(summaries))
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
