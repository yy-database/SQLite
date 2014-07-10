"""Same-workload comparison from Python: our writer/reader against `sqlite3`.

Both sides load the same row count, page size, transaction boundary
(``ROWS_PER_TXN`` rows per commit) and payload shape. SQLite runs with
``synchronous=OFF`` (no fsync barrier, comparable with our single in-memory
``save()``) and with ``synchronous=FULL`` as a durability reference.

Run: python bench/bench.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time

BENCH = pathlib.Path(__file__).resolve().parent
ROWS = 20_000
ROWS_PER_TXN = 1_000
POINT_OPS = 10_000
PAGE_SIZE = 4_096
PAYLOAD = b"x" * 48


def median(values: list[float]) -> float:
    return statistics.median(values)


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(len(ordered) * 0.95)) - 1))
    return ordered[index]


def run_ours(path: pathlib.Path) -> dict:
    completed = subprocess.run(
        [
            "node",
            str(BENCH / "ours.mjs"),
            str(path),
            str(ROWS),
            str(ROWS_PER_TXN),
            str(PAGE_SIZE),
            str(POINT_OPS),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip())
    return json.loads(completed.stdout)


def run_oracle_batch(path: pathlib.Path, synchronous: str) -> float:
    connection = sqlite3.connect(path)
    try:
        connection.execute(f"pragma page_size = {PAGE_SIZE}")
        connection.execute(f"pragma synchronous = {synchronous}")
        connection.execute("pragma journal_mode = memory")
        connection.execute(
            "create table items (id integer primary key, label text, score real, payload blob)"
        )
        start = time.perf_counter()
        for offset in range(0, ROWS, ROWS_PER_TXN):
            connection.execute("begin")
            connection.executemany(
                "insert into items (id, label, score, payload) values (?, ?, ?, ?)",
                [
                    (row, f"row-{row}", row / 4, PAYLOAD)
                    for row in range(offset + 1, offset + ROWS_PER_TXN + 1)
                ],
            )
            connection.execute("commit")
        return (time.perf_counter() - start) * 1_000
    finally:
        connection.close()


def run_oracle_single(path: pathlib.Path) -> list[float]:
    connection = sqlite3.connect(path)
    try:
        connection.execute("pragma synchronous = off")
        connection.execute("pragma journal_mode = memory")
        connection.execute(
            "create table items (id integer primary key, label text, score real, payload blob)"
        )
        samples: list[float] = []
        for row in range(1, 201):
            start = time.perf_counter()
            connection.execute(
                "insert into items (id, label, score, payload) values (?, ?, ?, ?)",
                (row, f"row-{row}", row / 4, PAYLOAD),
            )
            samples.append((time.perf_counter() - start) * 1_000_000)
        return samples
    finally:
        connection.close()


def run_oracle_scan(path: pathlib.Path, point: bool) -> list[float]:
    connection = sqlite3.connect(path)
    try:
        samples: list[float] = []
        if point:
            for index in range(POINT_OPS):
                rowid = ((index * 7919) % ROWS) + 1
                start = time.perf_counter()
                connection.execute(
                    "select id, label, score, payload from items where id = ?", (rowid,)
                ).fetchone()
                samples.append((time.perf_counter() - start) * 1_000_000)
        else:
            for _ in range(5):
                start = time.perf_counter()
                rows = connection.execute(
                    "select id, label, score, payload from items"
                ).fetchall()
                if len(rows) != ROWS:
                    raise RuntimeError(f"{len(rows)} rows, expected {ROWS}")
                samples.append((time.perf_counter() - start) * 1_000)
        return samples
    finally:
        connection.close()


def main() -> int:
    root = pathlib.Path(tempfile.mkdtemp(prefix="sqlite-py-bench-"))
    try:
        ours_path = root / "ours.sqlite3"
        off_path = root / "sqlite-off.sqlite3"
        full_path = root / "sqlite-full.sqlite3"
        insert_off_path = root / "insert-off.sqlite3"

        ours = run_ours(ours_path)
        oracle_off_ms = run_oracle_batch(off_path, "off")
        oracle_full_ms = run_oracle_batch(full_path, "full")
        rows: list[tuple[str, float, float, str]] = [
            (
                "our batch load 20k (4k page, 1k/txn, single save)",
                ours["batchLoadMs"],
                ours["batchLoadMs"],
                "ms",
            ),
            (
                "python sqlite3 batch load 20k (4k page, 1k/txn, synchronous=off)",
                oracle_off_ms,
                oracle_off_ms,
                "ms",
            ),
            (
                "python sqlite3 batch load 20k (4k page, 1k/txn, synchronous=full)",
                oracle_full_ms,
                oracle_full_ms,
                "ms",
            ),
        ]

        ours_single = [value * 1_000 for value in ours["singleMs"]]
        rows.append(
            (
                "our single insert 200 (autocommit writer op)",
                median(ours_single),
                p95(ours_single),
                "us",
            )
        )
        oracle_single = run_oracle_single(insert_off_path)
        rows.append(
            (
                "python sqlite3 single insert 200 (autocommit, synchronous=off)",
                median(oracle_single),
                p95(oracle_single),
                "us",
            )
        )

        rows.append(("our full scan 20k (open + decode all rows)", ours["scanMs"], ours["scanMs"], "ms"))
        oracle_scan = run_oracle_scan(off_path, False)
        rows.append(
            ("python sqlite3 full scan 20k (select all)", median(oracle_scan), p95(oracle_scan), "ms")
        )
        rows.append(
            (
                "our point lookup (open + bounded scan, no point API)",
                median(ours["pointMs"]) * 1_000,
                p95(ours["pointMs"]) * 1_000,
                "us",
            )
        )
        oracle_point = run_oracle_scan(off_path, True)
        rows.append(
            (
                "python sqlite3 point lookup 10k (where id = ?)",
                median(oracle_point),
                p95(oracle_point),
                "us",
            )
        )

        print(f"sqlite py bench · rows={ROWS} · txn={ROWS_PER_TXN} · page={PAGE_SIZE} · rounds=5")
        print()
        print("| workload | median | p95 | unit |")
        print("| --- | --- | --- | --- |")
        for name, center, tail, unit in rows:
            print(f"| {name} | {center:.3f} | {tail:.3f} | {unit} |")
        print()
        print("| file | bytes |")
        print("| --- | --- |")
        for label, path in (
            ("our", ours_path),
            ("sqlite off", off_path),
            ("sqlite full", full_path),
        ):
            print(f"| {label} | {path.stat().st_size} |")
        print()
        print(
            "Notes: our writer has no fsync switch, so its batch load is one in-memory build plus a single `save()`. `synchronous=off` is the closest SQLite setting and `synchronous=full` is a durability reference. Our reader has no point-lookup entry point, so the point row is a reopen plus bounded scan."
        )
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
