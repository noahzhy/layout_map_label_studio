from django.contrib import admin
from django.utils import timezone

from .models import LayoutProject, LayoutTask, LayoutTaskSnapshot


@admin.register(LayoutProject)
class LayoutProjectAdmin(admin.ModelAdmin):
    list_display = ['name', 'task_count', 'done_count', 'is_archived', 'created_by', 'created_at']
    list_filter = ['is_archived']
    search_fields = ['name', 'description']
    readonly_fields = ['created_at', 'updated_at', 'task_count', 'done_count']
    list_editable = ['is_archived']

    fieldsets = (
        (None, {'fields': ('name', 'description', 'is_archived')}),
        ('Meta', {'fields': ('created_by', 'created_at', 'updated_at')}),
    )

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    def task_count(self, obj):
        return obj.tasks.count()
    task_count.short_description = '任务数'

    def done_count(self, obj):
        return obj.tasks.filter(status__in=LayoutTask.completed_statuses()).count()
    done_count.short_description = '已完成'


@admin.register(LayoutTask)
class LayoutTaskAdmin(admin.ModelAdmin):
    list_display = [
        'store_id', 'project', 'assigned_to', 'status', 'last_saved_at', 'assigned_by', 'created_at',
    ]
    list_filter = ['status', 'project']
    search_fields = ['store_id', 'assigned_to__email', 'assigned_to__username', 'notes']
    raw_id_fields = ['assigned_to', 'assigned_by']
    readonly_fields = ['created_at', 'updated_at', 'last_saved_at']
    list_editable = ['status']
    date_hierarchy = 'created_at'

    fieldsets = (
        (None, {'fields': ('project', 'store_id', 'assigned_to', 'status')}),
        ('Meta', {'fields': ('notes', 'assigned_by', 'last_saved_at', 'created_at', 'updated_at')}),
    )

    def save_model(self, request, obj, form, change):
        if not change:
            obj.assigned_by = request.user
        super().save_model(request, obj, form, change)

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('assigned_to', 'assigned_by', 'project')


@admin.register(LayoutTaskSnapshot)
class LayoutTaskSnapshotAdmin(admin.ModelAdmin):
    list_display = [
        'id', 'scope', 'project', 'trigger_type', 'status', 'cutoff_at', 'created_by', 'finished_at',
    ]
    list_filter = ['scope', 'trigger_type', 'status', 'project']
    search_fields = ['project__name', 'error_message', 'created_by__email', 'created_by__username']
    raw_id_fields = ['project', 'created_by']
    readonly_fields = [
        'scope', 'project', 'trigger_type', 'status', 'created_by', 'cutoff_at', 'filters', 'counters', 'file',
        'error_message', 'created_at', 'updated_at', 'finished_at',
    ]
    ordering = ['-cutoff_at', '-created_at']

    fieldsets = (
        (None, {'fields': ('scope', 'project', 'trigger_type', 'status', 'file')}),
        ('Snapshot data', {'fields': ('cutoff_at', 'filters', 'counters', 'error_message')}),
        ('Meta', {'fields': ('created_by', 'created_at', 'updated_at', 'finished_at')}),
    )

    def has_add_permission(self, request):
        return False

    def has_view_permission(self, request, obj=None):
        return request.user.is_active and request.user.is_staff

    def has_change_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('project', 'created_by')

