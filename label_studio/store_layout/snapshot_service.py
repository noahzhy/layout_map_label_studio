from __future__ import annotations

import csv
import gzip
import io
import json
import logging
import os
import re
import zipfile
from collections import Counter

from core.redis import start_job_async_or_sync
from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from .models import LayoutTask, LayoutTaskSnapshot

logger = logging.getLogger(__name__)

LABEL_DATA_FILE = 'viewer_label.json.gz'
TASKS_CSV_NAME = 'tasks.csv'
ANNOTATORS_CSV_NAME = 'annotators.csv'
SUMMARY_JSON_NAME = 'summary.json'

TASK_FIELDNAMES = [
    'snapshot_cutoff_at',
    'project_id',
    'project_name',
    'store_id',
    'assigned_to_id',
    'assigned_to',
    'assigned_by_id',
    'assigned_by',
    'status',
    'status_display',
    'is_completed',
    'created_at',
    'updated_at',
    'last_saved_at',
    'annotation_saved_at',
    'annotation_parse_status',
    'annotation_parse_error',
    'annotation_total',
    'bbox_total',
    'polygon_total',
    'split_bbox_total',
    'split_leaf_total',
    'label_total',
    'label_breakdown',
]

ANNOTATOR_FIELDNAMES = [
    'assigned_to_id',
    'assigned_to',
    'assigned_task_total',
    'completed_task_total',
    'completion_rate_pct',
    'annotation_total',
    'bbox_total',
    'polygon_total',
    'split_bbox_total',
    'split_leaf_total',
    'label_total',
    'parse_issue_task_total',
    'status_breakdown',
    'store_ids',
]


def get_layout_data_dir():
    return os.path.join(settings.BASE_DATA_DIR, 'layout')


def get_layout_snapshot_queue_name():
    return getattr(settings, 'LAYOUT_SNAPSHOT_QUEUE_NAME', 'low')


def get_layout_snapshot_job_timeout():
    return int(getattr(settings, 'LAYOUT_SNAPSHOT_JOB_TIMEOUT', 60 * 60))


def _isoformat(value):
    if not value:
        return ''
    if hasattr(value, 'tzinfo'):
        return timezone.localtime(value).isoformat()
    return str(value)


def _user_display(user, empty='Unassigned'):
    if not user:
        return empty
    return user.email or user.username or f'User #{user.pk}'


def _normalize_text(value):
    return str(value).strip() if value is not None else ''


def _slugify_text(value):
    normalized = re.sub(r'[^a-zA-Z0-9]+', '-', _normalize_text(value).lower()).strip('-')
    return normalized or 'snapshot'


def _iter_split_leaves(node):
    if not isinstance(node, dict):
        return

    if node.get('kind') == 'split':
        yield from _iter_split_leaves(node.get('first'))
        yield from _iter_split_leaves(node.get('second'))
        return

    yield node


def _get_split_leaf_label(leaf):
    attrs = leaf.get('attributes') if isinstance(leaf, dict) else {}
    if not isinstance(attrs, dict):
        attrs = {}
    return _normalize_text(attrs.get('regionType') or attrs.get('label') or attrs.get('type'))


def _default_annotation_metrics():
    return {
        'annotation_parse_status': 'missing',
        'annotation_parse_error': 'Annotation file not found.',
        'annotation_saved_at': '',
        'annotation_total': 0,
        'bbox_total': 0,
        'polygon_total': 0,
        'split_bbox_total': 0,
        'split_leaf_total': 0,
        'label_total': 0,
        'label_breakdown': {},
    }


def collect_store_annotation_metrics(store_id, *, layout_data_dir=None):
    metrics = _default_annotation_metrics()
    base_dir = layout_data_dir or get_layout_data_dir()
    label_path = os.path.join(base_dir, store_id, LABEL_DATA_FILE)

    if not os.path.isfile(label_path):
        return metrics

    try:
        with gzip.open(label_path, 'rt', encoding='utf-8') as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ValueError('Annotation payload must be a JSON object.')
    except Exception as exc:  # noqa: BLE001 - reporting must survive broken files.
        metrics['annotation_parse_status'] = 'invalid'
        metrics['annotation_parse_error'] = str(exc)
        return metrics

    annotations = payload.get('annotations') if isinstance(payload.get('annotations'), list) else []
    label_counter = Counter()

    metrics['annotation_parse_status'] = 'ok'
    metrics['annotation_parse_error'] = ''
    metrics['annotation_saved_at'] = _normalize_text(payload.get('savedAt'))
    metrics['annotation_total'] = len(annotations)

    for annotation in annotations:
        if not isinstance(annotation, dict):
            continue

        annotation_type = _normalize_text(annotation.get('type'))
        label = _normalize_text(annotation.get('label'))

        if annotation_type == 'bbox':
            metrics['bbox_total'] += 1
            if label:
                label_counter[label] += 1
            continue

        if annotation_type == 'polygon':
            metrics['polygon_total'] += 1
            if label:
                label_counter[label] += 1
            continue

        if annotation_type == 'split-bbox':
            metrics['split_bbox_total'] += 1
            if label:
                label_counter[label] += 1

            attrs = annotation.get('attributes') if isinstance(annotation.get('attributes'), dict) else {}
            split_tree = attrs.get('splitTree') if isinstance(attrs, dict) else None
            for leaf in _iter_split_leaves(split_tree):
                metrics['split_leaf_total'] += 1
                leaf_label = _get_split_leaf_label(leaf)
                if leaf_label:
                    label_counter[leaf_label] += 1
            continue

        if label:
            label_counter[label] += 1

    metrics['label_breakdown'] = dict(sorted(label_counter.items()))
    metrics['label_total'] = sum(label_counter.values())
    return metrics


def build_layout_task_snapshot_rows(tasks, *, cutoff_at=None, layout_data_dir=None):
    cutoff_at = cutoff_at or timezone.now()
    completed_statuses = set(LayoutTask.completed_statuses())
    store_metrics_cache = {}
    task_rows = []
    assignee_summary = {}
    status_counter = Counter()
    parse_status_counter = Counter()
    project_counter = Counter()

    counters = {
        'scope_note': 'Counts are computed from current layout/<store_id>/viewer_label.json.gz payloads.',
        'cutoff_at': _isoformat(cutoff_at),
        'total_tasks': 0,
        'completed_task_total': 0,
        'annotation_total': 0,
        'bbox_total': 0,
        'polygon_total': 0,
        'split_bbox_total': 0,
        'split_leaf_total': 0,
        'label_total': 0,
        'annotator_count': 0,
        'project_count': 0,
        'status_breakdown': {},
        'parse_status_breakdown': {},
        'project_breakdown': {},
    }

    for task in tasks:
        metrics = store_metrics_cache.setdefault(
            task.store_id,
            collect_store_annotation_metrics(task.store_id, layout_data_dir=layout_data_dir),
        )

        assigned_to_display = _user_display(task.assigned_to)
        assigned_by_display = _user_display(task.assigned_by, empty='')
        project_name = task.project.name if task.project_id else ''
        is_completed = task.status in completed_statuses

        row = {
            'snapshot_cutoff_at': _isoformat(cutoff_at),
            'project_id': task.project_id or '',
            'project_name': project_name,
            'store_id': task.store_id,
            'assigned_to_id': task.assigned_to_id or '',
            'assigned_to': assigned_to_display,
            'assigned_by_id': task.assigned_by_id or '',
            'assigned_by': assigned_by_display,
            'status': task.status,
            'status_display': task.get_status_display(),
            'is_completed': '1' if is_completed else '0',
            'created_at': _isoformat(task.created_at),
            'updated_at': _isoformat(task.updated_at),
            'last_saved_at': _isoformat(task.last_saved_at),
            'annotation_saved_at': metrics['annotation_saved_at'],
            'annotation_parse_status': metrics['annotation_parse_status'],
            'annotation_parse_error': metrics['annotation_parse_error'],
            'annotation_total': metrics['annotation_total'],
            'bbox_total': metrics['bbox_total'],
            'polygon_total': metrics['polygon_total'],
            'split_bbox_total': metrics['split_bbox_total'],
            'split_leaf_total': metrics['split_leaf_total'],
            'label_total': metrics['label_total'],
            'label_breakdown': json.dumps(metrics['label_breakdown'], ensure_ascii=False, sort_keys=True),
        }
        task_rows.append(row)

        counters['total_tasks'] += 1
        counters['annotation_total'] += metrics['annotation_total']
        counters['bbox_total'] += metrics['bbox_total']
        counters['polygon_total'] += metrics['polygon_total']
        counters['split_bbox_total'] += metrics['split_bbox_total']
        counters['split_leaf_total'] += metrics['split_leaf_total']
        counters['label_total'] += metrics['label_total']
        if is_completed:
            counters['completed_task_total'] += 1

        status_counter[task.status] += 1
        parse_status_counter[metrics['annotation_parse_status']] += 1
        project_counter[project_name or 'Unassigned project'] += 1

        assignee_key = (task.assigned_to_id or 0, assigned_to_display)
        if assignee_key not in assignee_summary:
            assignee_summary[assignee_key] = {
                'assigned_to_id': task.assigned_to_id or '',
                'assigned_to': assigned_to_display,
                'assigned_task_total': 0,
                'completed_task_total': 0,
                'annotation_total': 0,
                'bbox_total': 0,
                'polygon_total': 0,
                'split_bbox_total': 0,
                'split_leaf_total': 0,
                'label_total': 0,
                'parse_issue_task_total': 0,
                'status_breakdown': Counter(),
                'store_ids': set(),
            }

        assignee_row = assignee_summary[assignee_key]
        assignee_row['assigned_task_total'] += 1
        assignee_row['annotation_total'] += metrics['annotation_total']
        assignee_row['bbox_total'] += metrics['bbox_total']
        assignee_row['polygon_total'] += metrics['polygon_total']
        assignee_row['split_bbox_total'] += metrics['split_bbox_total']
        assignee_row['split_leaf_total'] += metrics['split_leaf_total']
        assignee_row['label_total'] += metrics['label_total']
        assignee_row['status_breakdown'][task.status] += 1
        assignee_row['store_ids'].add(task.store_id)
        if is_completed:
            assignee_row['completed_task_total'] += 1
        if metrics['annotation_parse_status'] != 'ok':
            assignee_row['parse_issue_task_total'] += 1

    annotator_rows = []
    for _, summary in sorted(assignee_summary.items(), key=lambda item: (item[0][1].lower(), item[0][0])):
        assigned_total = summary['assigned_task_total'] or 0
        completion_rate = round(summary['completed_task_total'] * 100 / assigned_total, 2) if assigned_total else 0.0
        annotator_rows.append({
            'assigned_to_id': summary['assigned_to_id'],
            'assigned_to': summary['assigned_to'],
            'assigned_task_total': summary['assigned_task_total'],
            'completed_task_total': summary['completed_task_total'],
            'completion_rate_pct': completion_rate,
            'annotation_total': summary['annotation_total'],
            'bbox_total': summary['bbox_total'],
            'polygon_total': summary['polygon_total'],
            'split_bbox_total': summary['split_bbox_total'],
            'split_leaf_total': summary['split_leaf_total'],
            'label_total': summary['label_total'],
            'parse_issue_task_total': summary['parse_issue_task_total'],
            'status_breakdown': json.dumps(
                dict(sorted(summary['status_breakdown'].items())), ensure_ascii=False, sort_keys=True
            ),
            'store_ids': ', '.join(sorted(summary['store_ids'])),
        })

    counters['annotator_count'] = len(annotator_rows)
    counters['project_count'] = len(project_counter)
    counters['status_breakdown'] = dict(sorted(status_counter.items()))
    counters['parse_status_breakdown'] = dict(sorted(parse_status_counter.items()))
    counters['project_breakdown'] = dict(sorted(project_counter.items()))
    counters['missing_annotation_file_total'] = parse_status_counter.get('missing', 0)
    counters['invalid_annotation_file_total'] = parse_status_counter.get('invalid', 0)

    return task_rows, annotator_rows, counters


def render_csv(rows, fieldnames):
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: row.get(key, '') for key in fieldnames})
    return buffer.getvalue()


def build_layout_task_snapshot_archive(tasks, *, scope, project=None, cutoff_at=None, layout_data_dir=None):
    cutoff_at = cutoff_at or timezone.now()
    task_rows, annotator_rows, counters = build_layout_task_snapshot_rows(
        tasks,
        cutoff_at=cutoff_at,
        layout_data_dir=layout_data_dir,
    )

    metadata = {
        'scope': scope,
        'project_id': project.id if project else None,
        'project_name': project.name if project else '',
        'cutoff_at': counters['cutoff_at'],
        'counters': counters,
    }

    tasks_csv = render_csv(task_rows, TASK_FIELDNAMES)
    annotators_csv = render_csv(annotator_rows, ANNOTATOR_FIELDNAMES)

    timestamp = timezone.localtime(cutoff_at).strftime('%Y%m%d-%H%M%S')
    if scope == LayoutTaskSnapshot.Scope.PROJECT and project is not None:
        scope_slug = f'project-{project.id}-{_slugify_text(project.name)}'
    else:
        scope_slug = 'all-tasks'
    filename = f'store-layout-{scope_slug}-snapshot-{timestamp}.zip'

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(TASKS_CSV_NAME, tasks_csv)
        archive.writestr(ANNOTATORS_CSV_NAME, annotators_csv)
        archive.writestr(SUMMARY_JSON_NAME, json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True))

    return filename, archive_buffer.getvalue(), counters


def generate_layout_task_snapshot(snapshot_id):
    snapshot = LayoutTaskSnapshot.objects.select_related('project').get(pk=snapshot_id)
    snapshot.status = LayoutTaskSnapshot.Status.IN_PROGRESS
    snapshot.error_message = ''
    snapshot.finished_at = None
    snapshot.save(update_fields=['status', 'error_message', 'finished_at', 'updated_at'])

    try:
        tasks_qs = LayoutTask.objects.select_related('assigned_to', 'assigned_by', 'project')
        if snapshot.scope == LayoutTaskSnapshot.Scope.PROJECT and snapshot.project_id:
            tasks_qs = tasks_qs.filter(project_id=snapshot.project_id)

        tasks = list(tasks_qs.order_by('project__name', 'store_id', 'assigned_to__email', 'assigned_to__username', 'id'))
        filename, archive_bytes, counters = build_layout_task_snapshot_archive(
            tasks,
            scope=snapshot.scope,
            project=snapshot.project,
            cutoff_at=snapshot.cutoff_at,
        )

        if snapshot.file:
            snapshot.file.delete(save=False)
        snapshot.file.save(filename, ContentFile(archive_bytes), save=False)
        snapshot.status = LayoutTaskSnapshot.Status.COMPLETED
        snapshot.counters = counters
        snapshot.error_message = ''
        snapshot.finished_at = timezone.now()
        snapshot.save(update_fields=['file', 'status', 'counters', 'error_message', 'finished_at', 'updated_at'])
        return snapshot.pk
    except Exception as exc:  # noqa: BLE001 - stateful failure must be persisted.
        logger.exception('Failed to generate store layout snapshot %s', snapshot_id)
        snapshot.status = LayoutTaskSnapshot.Status.FAILED
        snapshot.error_message = str(exc)
        snapshot.finished_at = timezone.now()
        snapshot.save(update_fields=['status', 'error_message', 'finished_at', 'updated_at'])
        raise


def schedule_layout_task_snapshot(
    scope,
    *,
    project=None,
    trigger_type=LayoutTaskSnapshot.TriggerType.MANUAL,
    created_by=None,
    cutoff_at=None,
    filters=None,
    use_async=True,
):
    if scope == LayoutTaskSnapshot.Scope.PROJECT and project is None:
        raise ValueError('project is required when scope=project')

    snapshot_filters = dict(filters or {})
    snapshot_filters.setdefault('scope', scope)
    if project is not None:
        snapshot_filters.setdefault('project_id', project.id)

    snapshot = LayoutTaskSnapshot.objects.create(
        scope=scope,
        project=project if scope == LayoutTaskSnapshot.Scope.PROJECT else None,
        trigger_type=trigger_type,
        created_by=created_by,
        cutoff_at=cutoff_at or timezone.now(),
        filters=snapshot_filters,
    )

    start_snapshot_job = lambda: start_job_async_or_sync(
        generate_layout_task_snapshot,
        snapshot.pk,
        queue_name=get_layout_snapshot_queue_name(),
        job_timeout=get_layout_snapshot_job_timeout(),
        redis=use_async,
    )

    if use_async:
        transaction.on_commit(start_snapshot_job)
    else:
        start_snapshot_job()

    snapshot.refresh_from_db()
    return snapshot
