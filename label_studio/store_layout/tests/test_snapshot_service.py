import gzip
import io
import json
import zipfile

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from store_layout.models import LayoutProject, LayoutTask, LayoutTaskSnapshot
from store_layout.snapshot_service import collect_store_annotation_metrics, schedule_layout_task_snapshot


pytestmark = pytest.mark.django_db


@pytest.fixture
def layout_base_dir(settings, tmp_path):
    settings.BASE_DATA_DIR = str(tmp_path)
    settings.MEDIA_ROOT = str(tmp_path / 'media')
    return tmp_path / 'layout'


@pytest.fixture
def annotator():
    user_model = get_user_model()
    return user_model.objects.create_user(
        username='annotator',
        email='annotator@example.com',
        password='secret',
    )


@pytest.fixture
def reviewer():
    user_model = get_user_model()
    return user_model.objects.create_user(
        username='reviewer',
        email='reviewer@example.com',
        password='secret',
    )


@pytest.fixture
def layout_project(annotator):
    return LayoutProject.objects.create(name='Night Audit', created_by=annotator)


@pytest.fixture
def layout_task(layout_project, annotator, reviewer):
    return LayoutTask.objects.create(
        project=layout_project,
        store_id='task-001',
        assigned_to=annotator,
        assigned_by=reviewer,
        status=LayoutTask.Status.S1_DONE,
        last_saved_at=timezone.now(),
    )


def _write_label_payload(layout_base_dir, store_id, payload):
    store_dir = layout_base_dir / store_id
    store_dir.mkdir(parents=True, exist_ok=True)
    with gzip.open(store_dir / 'viewer_label.json.gz', 'wt', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False)


def test_collect_store_annotation_metrics_counts_bbox_polygon_and_split_leaves(layout_base_dir):
    _write_label_payload(
        layout_base_dir,
        'task-001',
        {
            'dataKind': 'store_layout_annotations',
            'savedAt': '2026-05-20T00:00:00+08:00',
            'annotations': [
                {'id': 1, 'type': 'bbox', 'label': 'Shelf', 'attributes': {}},
                {'id': 2, 'type': 'polygon', 'label': 'Boundary', 'attributes': {}},
                {
                    'id': 3,
                    'type': 'split-bbox',
                    'label': '',
                    'attributes': {
                        'splitTree': {
                            'id': 'root',
                            'kind': 'split',
                            'orientation': 'vertical',
                            'ratio': 0.5,
                            'first': {
                                'id': 'leaf-a',
                                'kind': 'leaf',
                                'attributes': {'regionType': 'Shelf'},
                            },
                            'second': {
                                'id': 'leaf-b',
                                'kind': 'leaf',
                                'attributes': {'regionType': 'Endcap'},
                            },
                        }
                    },
                },
            ],
        },
    )

    metrics = collect_store_annotation_metrics('task-001', layout_data_dir=str(layout_base_dir))

    assert metrics['annotation_parse_status'] == 'ok'
    assert metrics['annotation_total'] == 3
    assert metrics['bbox_total'] == 1
    assert metrics['polygon_total'] == 1
    assert metrics['split_bbox_total'] == 1
    assert metrics['split_leaf_total'] == 2
    assert metrics['label_total'] == 4
    assert metrics['label_breakdown'] == {'Boundary': 1, 'Endcap': 1, 'Shelf': 2}


def test_collect_store_annotation_metrics_handles_missing_files(layout_base_dir):
    metrics = collect_store_annotation_metrics('missing-task', layout_data_dir=str(layout_base_dir))

    assert metrics['annotation_parse_status'] == 'missing'
    assert metrics['annotation_total'] == 0
    assert metrics['bbox_total'] == 0
    assert metrics['label_breakdown'] == {}


def test_schedule_layout_task_snapshot_generates_zip_report(layout_base_dir, layout_project, layout_task):
    _write_label_payload(
        layout_base_dir,
        layout_task.store_id,
        {
            'dataKind': 'store_layout_annotations',
            'savedAt': '2026-05-20T00:00:00+08:00',
            'annotations': [
                {'id': 1, 'type': 'bbox', 'label': 'Shelf', 'attributes': {}},
                {'id': 2, 'type': 'polygon', 'label': 'Boundary', 'attributes': {}},
            ],
        },
    )

    snapshot = schedule_layout_task_snapshot(
        LayoutTaskSnapshot.Scope.PROJECT,
        project=layout_project,
        trigger_type=LayoutTaskSnapshot.TriggerType.MANUAL,
        use_async=False,
    )
    snapshot.refresh_from_db()

    assert snapshot.status == LayoutTaskSnapshot.Status.COMPLETED
    assert snapshot.file.name.endswith('.zip')
    assert snapshot.counters['total_tasks'] == 1
    assert snapshot.counters['bbox_total'] == 1
    assert snapshot.counters['polygon_total'] == 1

    snapshot.file.open('rb')
    archive = zipfile.ZipFile(io.BytesIO(snapshot.file.read()))
    assert {'tasks.csv', 'annotators.csv', 'summary.json'} <= set(archive.namelist())

    summary = json.loads(archive.read('summary.json').decode('utf-8'))
    tasks_csv = archive.read('tasks.csv').decode('utf-8')

    assert summary['counters']['total_tasks'] == 1
    assert layout_task.store_id in tasks_csv
    assert 'annotator@example.com' in tasks_csv
