from django.contrib import admin
from django.utils import timezone

from .models import LayoutTask


@admin.register(LayoutTask)
class LayoutTaskAdmin(admin.ModelAdmin):
    list_display = [
        'store_id', 'assigned_to', 'status', 'last_saved_at', 'assigned_by', 'created_at',
    ]
    list_filter = ['status']
    search_fields = ['store_id', 'assigned_to__email', 'assigned_to__username', 'notes']
    raw_id_fields = ['assigned_to', 'assigned_by']
    readonly_fields = ['created_at', 'updated_at', 'last_saved_at']
    list_editable = ['status']
    date_hierarchy = 'created_at'

    fieldsets = (
        (None, {'fields': ('store_id', 'assigned_to', 'status')}),
        ('Meta', {'fields': ('notes', 'assigned_by', 'last_saved_at', 'created_at', 'updated_at')}),
    )

    def save_model(self, request, obj, form, change):
        if not change:
            obj.assigned_by = request.user
        super().save_model(request, obj, form, change)

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('assigned_to', 'assigned_by')
