import gzip
import json
import logging
import os
import re

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, HttpResponse, HttpResponseForbidden, HttpResponseNotAllowed, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import LayoutProject, LayoutTask

User = get_user_model()

logger = logging.getLogger(__name__)

LAYOUT_DATA_DIR = os.path.join(settings.BASE_DATA_DIR, 'layout')
ALLOWED_SAVE_FILENAMES = {'viewer_label.json.gz', 'viewer_map.json.gz'}


def _is_admin(user):
    return user.is_staff or user.is_superuser


def _status_options():
    return [{'value': value, 'label': label} for value, label in LayoutTask.Status.choices]


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


# ── Project list ────────────────────────────────────────────────────────────

@login_required
def index(request):
    """
    Project list page.
    Admin: all projects with task counters.
    Annotator: only projects where they have at least one task.
    """
    if _is_admin(request.user):
        projects = LayoutProject.objects.filter(is_archived=False).prefetch_related('tasks__assigned_to')
    else:
        # Only projects where the user has a task
        project_ids = LayoutTask.objects.filter(
            assigned_to=request.user
        ).values_list('project_id', flat=True).distinct()
        projects = LayoutProject.objects.filter(id__in=project_ids, is_archived=False)

    project_list = []
    for proj in projects:
        tasks = list(proj.tasks.all())
        total = len(tasks)
        done = sum(1 for t in tasks if t.status in LayoutTask.completed_statuses())
        project_list.append({
            'obj': proj,
            'total': total,
            'done': done,
            'progress': int(done / total * 100) if total else 0,
        })

    return render(request, 'store_layout/index.html', {
        'projects': project_list,
        'is_admin': _is_admin(request.user),
    })


# ── Project detail (store list) ─────────────────────────────────────────────

@login_required
def project_detail(request, pk):
    """
    Show stores within a project.
    Admin: all tasks for this project.
    Annotator: only their assigned stores in this project.
    """
    project = get_object_or_404(LayoutProject, pk=pk)
    on_disk = _available_store_ids()

    if _is_admin(request.user):
        tasks_qs = LayoutTask.objects.filter(project=project).select_related('assigned_to').order_by('store_id', 'assigned_to__email')
        tasks_by_store: dict = {}
        for t in tasks_qs:
            tasks_by_store.setdefault(t.store_id, []).append(t)

        # Include all store_ids from tasks (even if no file on disk yet) + on_disk stores in this project
        all_store_ids = sorted(set(tasks_by_store.keys()))
        stores = []
        for store_id in all_store_ids:
            tasks = tasks_by_store.get(store_id, [])
            stores.append({
                'id': store_id,
                'name': store_id.replace('_', ' ').replace('-', ' ').title(),
                'tasks': tasks,
                'unassigned': len(tasks) == 0,
                'on_disk': store_id in on_disk,
            })
        return render(request, 'store_layout/store_list.html', {
            'project': project,
            'stores': stores,
            'is_admin': True,
        })
    else:
        my_tasks = LayoutTask.objects.filter(
            project=project, assigned_to=request.user
        ).order_by('store_id')
        stores = []
        for task in my_tasks:
            if task.store_id in on_disk:
                stores.append({
                    'id': task.store_id,
                    'name': task.store_id.replace('_', ' ').replace('-', ' ').title(),
                    'task': task,
                })
        return render(request, 'store_layout/store_list.html', {
            'project': project,
            'stores': stores,
            'is_admin': False,
        })


# ── Viewer ───────────────────────────────────────────────────────────────────

@login_required
def viewer_page(request, store_id):
    """Render the Store Layout SPA and check access rights."""
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    task = LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).select_related('project').first()
    if not _is_admin(request.user) and task is None:
        return HttpResponseForbidden('You are not assigned to this store.')

    return render(request, 'store_layout/viewer.html', {
        'store_id': store_id,
        'data_base_url': f'/store_layout/{store_id}/',
        'task': task,
        'project': task.project if task else None,
        'status_options': _status_options(),
    })


@login_required
def translation_table(request):
    """Render the sub-category translation reference page."""
    return render(request, 'store_layout/translation_table.html')


@login_required
def store_assets(request, store_id):
    """Return store asset metadata for the viewer UI.

    CSV outputs are expected under ``<store>/assets/``.
    """
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    if not _is_admin(request.user):
        if not LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).exists():
            return HttpResponseForbidden('Not assigned to this store.')

    assets_path = os.path.join(store_path, 'assets')
    files = []
    directories = []
    csv_files = []

    try:
        for entry in os.scandir(store_path):
            if entry.is_dir(follow_symlinks=False):
                directories.append(entry.name)

        if os.path.isdir(assets_path):
            for entry in os.scandir(assets_path):
                if not entry.is_file(follow_symlinks=False):
                    continue

                stat = entry.stat()
                name = entry.name
                lower_name = name.lower()
                ext = os.path.splitext(lower_name)[1]
                files.append({
                    'name': name,
                    'relative_path': f'assets/{name}',
                    'size': stat.st_size,
                    'mtime': int(stat.st_mtime * 1000),
                    'extension': ext,
                })
                if lower_name.endswith('.csv'):
                    csv_files.append(name)
    except OSError as exc:
        logger.error('Failed to list store assets for %s: %s', store_id, exc)
        return JsonResponse({'status': 'error', 'message': 'Failed to read store assets.'}, status=500)

    files.sort(key=lambda item: item['name'])
    directories.sort()
    csv_files.sort()

    response = JsonResponse({
        'status': 'ok',
        'store_id': store_id,
        'asset_base_url': f'/store_layout/{store_id}/assets/',
        'asset_directory_exists': os.path.isdir(assets_path),
        'files': files,
        'directories': directories,
        'csv_files': csv_files,
        'has_csv': bool(csv_files),
        'unique_csv': csv_files[0] if len(csv_files) == 1 else None,
    })
    response['Cache-Control'] = 'no-cache, must-revalidate'
    return response


# ── Save data ────────────────────────────────────────────────────────────────

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
    if filename not in ALLOWED_SAVE_FILENAMES:
        return HttpResponse('Unsupported filename', status=400)

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

        # Update task save timestamp only; annotators manage status explicitly from the viewer UI.
        LayoutTask.objects.filter(
            store_id=store_id, assigned_to=request.user,
        ).update(last_saved_at=timezone.now(), updated_at=timezone.now())

        return JsonResponse({'status': 'ok', 'filename': filename})

    except Exception as e:
        logger.error(f'Failed to save layout data: {e}')
        return HttpResponse(f'Save failed: {e}', status=500)


# ── Serve layout files (images, json.gz, etc.) ───────────────────────────────

@login_required
def serve_file(request, store_id, filename):
    """Serve files from the store directory.

    Used as a fallback when nginx is not in front of Django (single-container
    deployments). Performs the same access checks as viewer_page.
    """
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    # Allow nested paths (e.g. images/foo.jpg) but disallow traversal.
    if '..' in filename.split('/') or filename.startswith('/'):
        return HttpResponse('Invalid filename', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    # Access check: admins always allowed; annotators must be assigned.
    if not _is_admin(request.user):
        if not LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).exists():
            return HttpResponseForbidden('Not assigned to this store.')

    target_path = os.path.join(store_path, filename)
    real_store = os.path.realpath(store_path)
    real_target = os.path.realpath(target_path)
    if not real_target.startswith(real_store + os.sep):
        return HttpResponse('Invalid path', status=400)
    if not os.path.isfile(real_target):
        return HttpResponse('File not found', status=404)

    resp = FileResponse(open(real_target, 'rb'))
    # Pre-gzipped JSON: tell the browser so it auto-decompresses.
    if filename.endswith('.json.gz'):
        resp['Content-Type'] = 'application/json'
        resp['Content-Encoding'] = 'gzip'
        resp['Cache-Control'] = 'no-cache, must-revalidate'
    return resp


# ── Mark done ────────────────────────────────────────────────────────────────

@login_required
@require_POST
def mark_done(request, store_id):
    """Backward-compatible shortcut: mark the task as S1 done."""
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    qs = LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user)
    if not qs.exists() and not _is_admin(request.user):
        return JsonResponse({'status': 'error', 'message': 'Task not found'}, status=404)

    updated = qs.update(
        status=LayoutTask.Status.S1_DONE,
        updated_at=timezone.now(),
    )
    if updated == 0:
        return JsonResponse({'status': 'error', 'message': 'Nothing to update'}, status=409)

    return JsonResponse({
        'status': 'ok',
        'store_id': store_id,
        'task_status': LayoutTask.Status.S1_DONE,
        'task_status_display': LayoutTask.Status.S1_DONE.label,
    })


@login_required
@require_POST
def update_status(request, store_id):
    """Update the current annotator's LayoutTask status from the viewer page."""
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({'status': 'error', 'message': 'Invalid JSON'}, status=400)

    next_status = payload.get('status')
    valid_statuses = {value for value, _ in LayoutTask.Status.choices}
    if next_status not in valid_statuses:
        return JsonResponse({'status': 'error', 'message': 'Invalid status'}, status=400)

    task = LayoutTask.objects.filter(store_id=store_id, assigned_to=request.user).first()
    if task is None:
        if not _is_admin(request.user):
            return JsonResponse({'status': 'error', 'message': 'Task not found'}, status=404)
        task = LayoutTask.objects.filter(store_id=store_id).order_by('id').first()
        if task is None:
            return JsonResponse({'status': 'error', 'message': 'Task not found'}, status=404)

    task.status = next_status
    task.updated_at = timezone.now()
    task.save(update_fields=['status', 'updated_at'])

    return JsonResponse({
        'status': 'ok',
        'store_id': store_id,
        'task_status': task.status,
        'task_status_display': task.get_status_display(),
    })


# ── Assign tasks (admin only) ─────────────────────────────────────────────────

@login_required
def assign_tasks(request, pk):
    """
    GET : show the assignment management page for a project.
    POST: receive [{store_id, user_id|null}, ...] and upsert LayoutTask records.
          user_id=null means "unassign" (delete the task if it exists).
    Admin only.
    """
    if not _is_admin(request.user):
        return HttpResponseForbidden('Admin access required.')

    project = get_object_or_404(LayoutProject, pk=pk)

    if request.method == 'POST':
        try:
            payload = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            return JsonResponse({'status': 'error', 'message': 'Invalid JSON'}, status=400)

        created_count = 0
        updated_count = 0
        deleted_count = 0

        for item in payload:
            store_id = item.get('store_id', '').strip()
            user_id = item.get('user_id')  # may be None / null

            if not store_id or not re.match(r'^[\w\-]+$', store_id):
                continue

            if user_id is None:
                # Unassign: remove tasks for this store in this project
                deleted_count += LayoutTask.objects.filter(
                    project=project, store_id=store_id
                ).delete()[0]
                continue

            try:
                user = User.objects.get(pk=user_id)
            except User.DoesNotExist:
                continue

            # Upsert: one task per (project, store_id) — overwrite assignee if changed
            existing = LayoutTask.objects.filter(project=project, store_id=store_id).first()
            if existing:
                if existing.assigned_to_id != user.pk:
                    existing.assigned_to = user
                    existing.assigned_by = request.user
                    existing.status = LayoutTask.Status.UNANNOTATED
                    existing.last_saved_at = None
                    existing.updated_at = timezone.now()
                    existing.save()
                    updated_count += 1
            else:
                LayoutTask.objects.create(
                    project=project,
                    store_id=store_id,
                    assigned_to=user,
                    assigned_by=request.user,
                    status=LayoutTask.Status.UNANNOTATED,
                )
                created_count += 1

        return JsonResponse({
            'status': 'ok',
            'created': created_count,
            'updated': updated_count,
            'deleted': deleted_count,
        })

    # GET: build page data
    on_disk = _available_store_ids()

    # Existing tasks for this project, keyed by store_id
    existing_tasks = {
        t.store_id: t
        for t in LayoutTask.objects.filter(project=project).select_related('assigned_to')
    }

    # All store directories on disk (union with already-assigned stores)
    all_store_ids = sorted(on_disk | set(existing_tasks.keys()))

    stores = []
    for sid in all_store_ids:
        task = existing_tasks.get(sid)
        stores.append({
            'id': sid,
            'name': sid.replace('_', ' ').replace('-', ' ').title(),
            'on_disk': sid in on_disk,
            'task': task,
            'assigned_to_id': task.assigned_to_id if task else None,
            'assigned_to_email': (task.assigned_to.email or task.assigned_to.username) if task else '',
            'status': task.status if task else '',
        })

    annotators = list(
        User.objects.filter(is_active=True, is_staff=False, is_superuser=False)
        .order_by('email')
        .values('id', 'email', 'username')
    )
    # Ensure email is displayed even if blank
    for a in annotators:
        a['display'] = a['email'] or a['username']

    return render(request, 'store_layout/assign.html', {
        'project': project,
        'stores': stores,
        'annotators': annotators,
        'total': len(stores),
        'assigned': sum(1 for s in stores if s['task']),
        'unassigned': sum(1 for s in stores if not s['task']),
    })
