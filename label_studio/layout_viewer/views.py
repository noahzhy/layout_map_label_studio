import gzip
import logging
import os
import re

from django.conf import settings
from django.http import FileResponse, HttpResponse, HttpResponseNotAllowed, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt

logger = logging.getLogger(__name__)

LAYOUT_DATA_DIR = os.path.join(settings.BASE_DATA_DIR, 'layout')


def _get_stores():
    """List available store directories under LAYOUT_DATA_DIR."""
    if not os.path.isdir(LAYOUT_DATA_DIR):
        return []
    stores = []
    for name in sorted(os.listdir(LAYOUT_DATA_DIR)):
        store_path = os.path.join(LAYOUT_DATA_DIR, name)
        if os.path.isdir(store_path):
            # Check if there's at least one viewer_*.json.gz
            has_data = any(
                f.startswith('viewer_') and f.endswith('.json.gz')
                for f in os.listdir(store_path)
            )
            if has_data:
                stores.append({
                    'id': name,
                    'name': name.replace('_', ' ').replace('-', ' ').title(),
                    'files': sorted([
                        f for f in os.listdir(store_path)
                        if f.endswith('.json.gz')
                    ]),
                })
    return stores


def index(request):
    """List all available stores."""
    stores = _get_stores()
    return render(request, 'layout_viewer/index.html', {'stores': stores})


def viewer_page(request, store_id):
    """Render the layout viewer for a specific store."""
    # Validate store_id to prevent path traversal
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    return render(request, 'layout_viewer/viewer.html', {
        'store_id': store_id,
        'data_base_url': f'/layout-data/{store_id}/',
    })


@csrf_exempt
def save_data(request, store_id):
    """Save annotation data (gzipped JSON) back to the store directory."""
    if request.method != 'POST':
        return HttpResponseNotAllowed(['POST'])

    # Validate store_id to prevent path traversal
    if not re.match(r'^[\w\-]+$', store_id):
        return HttpResponse('Invalid store ID', status=400)

    store_path = os.path.join(LAYOUT_DATA_DIR, store_id)
    if not os.path.isdir(store_path):
        return HttpResponse('Store not found', status=404)

    # Get filename from query param, validate it
    filename = request.GET.get('filename', 'viewer_label.json.gz')
    # Sanitize filename - only allow safe characters
    filename = os.path.basename(filename)
    if not re.match(r'^[\w\-\.]+$', filename):
        return HttpResponse('Invalid filename', status=400)
    if not filename.endswith('.json.gz'):
        filename += '.json.gz'

    target_path = os.path.join(store_path, filename)

    # Verify the resolved path is still within the store directory
    real_store = os.path.realpath(store_path)
    real_target = os.path.realpath(target_path)
    if not real_target.startswith(real_store + os.sep):
        return HttpResponse('Invalid path', status=400)

    try:
        body = request.body
        if not body:
            return HttpResponse('Empty body', status=400)

        # Check if body is already gzipped (starts with gzip magic bytes)
        is_gzipped = body[:2] == b'\x1f\x8b'

        if is_gzipped:
            with open(target_path, 'wb') as f:
                f.write(body)
        else:
            with gzip.open(target_path, 'wb') as f:
                f.write(body)

        logger.info(f'Saved layout data to {target_path} ({len(body)} bytes)')
        return JsonResponse({'status': 'ok', 'filename': filename})

    except Exception as e:
        logger.error(f'Failed to save layout data: {e}')
        return HttpResponse(f'Save failed: {e}', status=500)
