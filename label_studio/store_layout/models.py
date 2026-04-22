from django.conf import settings
from django.db import models


class LayoutProject(models.Model):
    """A named labeling project that groups store Tasks."""

    name = models.CharField(max_length=256, help_text='Project name')
    description = models.TextField(blank=True, help_text='Project description / notes for annotators')
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name='created_layout_projects',
    )
    is_archived = models.BooleanField(default=False, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = 'store_layout'
        ordering = ['-created_at']
        verbose_name = 'Layout Project'
        verbose_name_plural = 'Projects'

    def __str__(self):
        return self.name

    def task_count(self):
        return self.tasks.count()

    def done_count(self):
        return self.tasks.filter(status__in=['done', 'reviewed']).count()


class LayoutTask(models.Model):
    """Tracks assignment of a store layout labeling task to a specific annotator."""

    class Status(models.TextChoices):
        PENDING = 'pending', '待标注'
        IN_PROGRESS = 'in_progress', '标注中'
        DONE = 'done', '已完成'
        REVIEWED = 'reviewed', '已审核'

    store_id = models.CharField(
        max_length=256,
        db_index=True,
        help_text='Directory name under mydata/layout/',
    )
    project = models.ForeignKey(
        LayoutProject,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='tasks',
        help_text='Parent project (optional)',
    )
    assigned_to = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='layout_tasks',
        null=True,
        blank=True,
        help_text='Annotator assigned to label this store',
    )
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name='layout_tasks_assigned_by',
        null=True,
        blank=True,
        help_text='Admin who created this assignment',
    )
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    notes = models.TextField(blank=True, help_text='Admin notes about this task')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_saved_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Last time the annotator saved annotation data',
    )

    class Meta:
        app_label = 'store_layout'
        unique_together = [('store_id', 'assigned_to')]
        ordering = ['-created_at']
        verbose_name = 'Layout Task'
        verbose_name_plural = 'Tasks'

    def __str__(self):
        user_str = self.assigned_to.email if self.assigned_to_id else 'unassigned'
        return f'{self.store_id} → {user_str} [{self.status}]'
