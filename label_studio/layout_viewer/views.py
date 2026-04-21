import gzip
import logging
import os
import re

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import HttpResponse, HttpResponseForbidden, HttpResponseNotAllowed, JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import LayoutTask

logger = logging.getLogger(__name__)

LAYOUT_DATA_DIR = os.path.join(settings.BASE_DATA_DIR, 'layout')


def _is_admin(user):
    return user.is_staff or user.is_superuser


def _available_store_ids():
    """Return a set of store_ids that have data on disk."""
    if not os.path.isdir(LAYOUT_DATA_DIR):
        return set()
    result = set()
    for name in os.listdir(LAYOUT_DATA_DIR):
        store_path = os.path.join(LAYOUT_DATA_DIR, name)
        if os.path.isdir(store_path) and any(
            f.startswith('viewer_') and f.endswith('.json.gz')
            for f in os.listdir(store_path)
        ):
            result.add(name)
    return result


@login_required
def index(request):
    """
    Admin: all stores + assignment/status table.
    Annotator: only their assigned stores.
    """
    on_disk = _available_store_ids()

    if _is_admin(request.user):
        tasks_qs = LayoutTask.objects.select_related('assigned_to').order_by('store_id', 'assigned_to__email')
        tasks_by_store: dict = {}
        for t in tasks_qs:
            tasks_by_store.setdefault(t.store_id, []).append(t)

        stores = []
        for store_id in sorted(on_disk):
            tasks = tasks_by_store.get(store_id, [])
            stores.append({
                'id': store_id,
                'name': store_id.replace('_', ' ').replace('-', ' ').title(),
                'tasks': tasks,
                'unassigned': len(tasks) == 0,
            })
        return render(request, 'layout_viewer/index.html', {'stores': stores, 'is_admin': True})
    else:
        my_tasks = LayoutTask.objects.filter(assigned_to=request.user).order_by('store_id')
        stores = []
        for task in my_tasks:
            if task.store_id in on_disk:
                stores.append({
                    'id': task.store_id,
                    'name': task.store_id.replace('_', ' ').replace('-', ' ').title(),
                    'task': task,
                })
        return render(request, 'layout_viewer/index.html', {'stores': stores, 'is_admin': False})


@login_required
def viewer_page(request, store_id):
    """Render the layout viewer SPA. Checks access rights and advances task state."""
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    task = LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).first()
    if not _is_admin(request.user) and task is None:
        return HttpResponseForbidden('You are not assigned to this store.')

    # Advance pending → in_progress on first open
    if task and task.status == LayoutTask.Status.PENDING:
        task.status = LayoutTask.Status.IN_PROGRESS
        task.save(update_fields=['status', 'updated_at'])

    return render(request, 'layout_viewer/viewer.html', {
        'store_id': store_id,
        'data_base_url': f'/layout-data/{store_id}/',
        'task': task,
    })


@csrf_exempt
def save_data(request, store_id):
    """Save annotation data (gzipped JSON) back to the store directory."""
    if request.method != 'POST':
        return HttpResponseNotAllowed(['POST'])

    if not request.user.is_authenticated:
        return HttpResponse('Unauthorized', status=401)

    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    # Access check
    if not _is_admin(request.user):
        if not LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).exists():
            return HttpResponseForbidden('Not assigned to this store.')

    filename = request.GET.get('filename', 'viewer_label.json.gz')
    filename = os.path.basename(filename)
    if not re.match(r'^[\w\-\.]+$', filename):
        return HttpResponse('Invalid filename', status=400)
    if not filename.endswith('.json.gz'):
        filename += '.json.gz'

    target_path = os.path.join(store_path, filename)
    real_store = os.path.realpath(store_path)
    real_target = os.path.realpath(target_path)
    if not real_target.startswith(real_store + os.sep):
        return HttpResponse('Invalid path', status=400)

    try:
        body = request.body
        if not body:
            return HttpResponse('Empty body', status=400)

        is_gzipped = body[:2] == b'\x1f\x8b'
        if is_gzipped:
            with open(target_path, 'wb') as f:
                f.write(body)
        else:
            with gzip.open(target_path, 'wb') as f:
                f.write(body)

        logger.info(f'Saved layout data to {target_path} ({len(body)} bytes)')

        # Update task status / timestamp
        LayoutTask.objects.filter(
            store_id=store_id, assigned_to=request.user,
            status__in=[LayoutTask.Status.PENDING, LayoutTask.Status.IN_PROGRESS]
        ).update(last_saved_at=timezone.now(), status=LayoutTask.Status.IN_PROGRESS,
                 updated_at=timezone.now())

        return JsonResponse({'status': 'ok', 'filename': filename})

    except Exception as e:
        logger.error(f'Failed to save layout data: {e}')
        return HttpResponse(f'Save failed: {e}', status=500)


@login_required
@require_POST
def mark_done(request, store_id):
    """Mark the current user's LayoutTask for this store as done."""
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    qs = LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user)
    if not qs.exists() and not _is_admin(request.user):
        return JsonResponse({'status': 'error', 'message': 'Task not found'}, status=404)

    updated = qs.exclude(status=LayoutTask.Status.REVIEWED).update(
        status=LayoutTask.Status.DONE,
        updated_at=timezone.now(),
    )
    if updated == 0:
        return JsonResponse({'status': 'error', 'message': 'Nothing to update (already reviewed?)'}, status=409)

    return JsonResponse({'status': 'ok', 'store_id': store_id})
