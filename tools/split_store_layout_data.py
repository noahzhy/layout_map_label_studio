#!/usr/bin/env python3
"""Split legacy Store Layout viewer_label.json.gz into map and annotation files.

Legacy Store Layout data stored point cloud / cameras and user annotations in one
large ``viewer_label.json.gz`` file.  This script migrates that format into:

- ``viewer_map.json.gz``: point cloud, cameras, map metadata, map-adjacent data
- ``viewer_label.json.gz``: user annotations and annotation-only state

By default the original file is backed up before it is replaced.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAP_FILE = 'viewer_map.json.gz'
LABEL_FILE = 'viewer_label.json.gz'
MAP_KEYS = {
    'pointCloud',
    'cameras',
    'mapAnnotations',
    'metadata',
    'matchPairs',
    'trackPairs',
    'recogData',
    'rotationApplied',
}
LABEL_KEYS = {
    'annotations',
    'scaleCalibration',
}


def load_json(path: Path) -> dict[str, Any]:
    opener = gzip.open if path.suffix == '.gz' or path.name.endswith('.json.gz') else open
    with opener(path, 'rt', encoding='utf-8') as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f'{path} does not contain a JSON object')
    return data


def write_json_gz(path: Path, payload: dict[str, Any]) -> None:
    with gzip.open(path, 'wt', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))


def split_payload(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    now = datetime.now(timezone.utc).isoformat()

    map_payload: dict[str, Any] = {
        'schemaVersion': 2,
        'dataKind': 'store_layout_map',
        'updatedAt': now,
    }
    for key in MAP_KEYS:
        if key in data:
            map_payload[key] = data[key]

    # Keep empty defaults for core map fields so the viewer receives a stable shape.
    map_payload.setdefault('pointCloud', [])
    map_payload.setdefault('cameras', [])
    map_payload.setdefault('mapAnnotations', [])
    map_payload.setdefault('metadata', {})
    map_payload.setdefault('rotationApplied', 0)

    label_payload: dict[str, Any] = {
        'schemaVersion': 2,
        'dataKind': 'store_layout_annotations',
        'mapFile': MAP_FILE,
        'savedAt': now,
    }
    for key in LABEL_KEYS:
        if key in data:
            label_payload[key] = data[key]

    label_payload.setdefault('annotations', [])

    # Preserve unknown annotation-side fields, but never copy bulky map fields.
    excluded = MAP_KEYS | LABEL_KEYS
    for key, value in data.items():
        if key in excluded:
            continue
        if key.startswith('label') or key in {'task', 'project', 'annotationVersion'}:
            label_payload[key] = value

    return map_payload, label_payload


def is_legacy_full_payload(data: dict[str, Any]) -> bool:
    return any(key in data for key in ('pointCloud', 'cameras', 'metadata')) and 'annotations' in data


def resolve_input_paths(path: Path, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path]

    if not path.is_dir():
        raise FileNotFoundError(path)

    direct = path / LABEL_FILE
    if direct.is_file():
        return [direct]

    pattern = f'**/{LABEL_FILE}' if recursive else f'*/{LABEL_FILE}'
    return sorted(path.glob(pattern))


def migrate_file(label_path: Path, *, dry_run: bool, force: bool, no_backup: bool) -> str:
    store_dir = label_path.parent
    map_path = store_dir / MAP_FILE
    data = load_json(label_path)

    if not is_legacy_full_payload(data):
        return f'skip {label_path}: not a legacy full payload'

    if map_path.exists() and not force:
        return f'skip {label_path}: {MAP_FILE} already exists (use --force to overwrite)'

    map_payload, label_payload = split_payload(data)
    annotation_count = len(label_payload.get('annotations') or [])
    camera_count = len(map_payload.get('cameras') or [])
    point_count = len(map_payload.get('pointCloud') or [])

    if dry_run:
        return (
            f'dry-run {label_path}: {point_count} points, {camera_count} cameras, '
            f'{annotation_count} annotations -> {MAP_FILE} + slim {LABEL_FILE}'
        )

    if not no_backup:
        timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_path = store_dir / f'viewer_label.full_backup.{timestamp}.json.gz'
        shutil.copy2(label_path, backup_path)

    write_json_gz(map_path, map_payload)
    write_json_gz(label_path, label_payload)
    return (
        f'migrated {label_path}: {point_count} points, {camera_count} cameras, '
        f'{annotation_count} annotations'
    )


def main() -> int:
    parser = argparse.ArgumentParser(description='Split legacy Store Layout map and annotation data')
    parser.add_argument('path', type=Path, help='viewer_label.json.gz, a store directory, or a layout directory')
    parser.add_argument('--recursive', action='store_true', help='Search recursively for viewer_label.json.gz under PATH')
    parser.add_argument('--dry-run', action='store_true', help='Print planned changes without writing files')
    parser.add_argument('--force', action='store_true', help='Overwrite existing viewer_map.json.gz')
    parser.add_argument('--no-backup', action='store_true', help='Do not create viewer_label.full_backup.<timestamp>.json.gz')
    args = parser.parse_args()

    paths = resolve_input_paths(args.path, args.recursive)
    if not paths:
        print(f'No {LABEL_FILE} files found under {args.path}')
        return 1

    failures = 0
    for label_path in paths:
        try:
            print(migrate_file(label_path, dry_run=args.dry_run, force=args.force, no_backup=args.no_backup))
        except Exception as exc:  # noqa: BLE001 - CLI should report all files and continue.
            failures += 1
            print(f'error {label_path}: {exc}')

    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
