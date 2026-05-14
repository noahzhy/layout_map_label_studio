from django.contrib import admin
from django.utils import timezone

from .models import LayoutProject, LayoutTask


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

