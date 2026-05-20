from django.conf import settings
from django.db import models
from django.utils import timezone


def layout_snapshot_upload_to(instance, filename):
    base_dir = getattr(settings, 'DELAYED_EXPORT_DIR', 'export').strip('/').rstrip('/') or 'export'
    return f'{base_dir}/store_layout_snapshots/{filename}'


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
        return self.tasks.filter(status__in=LayoutTask.completed_statuses()).count()


class LayoutTask(models.Model):
    """Tracks assignment of a store layout labeling task to a specific annotator."""

    class Status(models.TextChoices):
        UNANNOTATED = 'unannotated', '未标注'
        S1_IN_PROGRESS = 's1_in_progress', 'S1标注中'
        S1_DONE = 's1_done', 'S1标注完成'
        S2_IN_PROGRESS = 's2_in_progress', 'S2标注中'
        S2_DONE = 's2_done', 'S2标注完成'
        REVIEWED = 'reviewed', '已审核'
        MAP_ISSUE = 'map_issue', '地图问题'
        UNKNOWN_ERROR = 'unknown_error', '未知错误'
        REVIEW_IN_PROGRESS = 'review_in_progress', '审核中'
        REVIEW_REJECTED = 'review_rejected', '审核未通过'

    @classmethod
    def completed_statuses(cls):
        return [cls.Status.S1_DONE, cls.Status.S2_DONE, cls.Status.REVIEWED]

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
        default=Status.UNANNOTATED,
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


class LayoutTaskSnapshot(models.Model):
    """Persisted export snapshots for Store Layout task assignment/reporting state."""

    class Scope(models.TextChoices):
        PROJECT = 'project', 'Project'
        ALL_TASKS = 'all_tasks', 'All tasks'

    class TriggerType(models.TextChoices):
        MANUAL = 'manual', 'Manual'
        SCHEDULED = 'scheduled', 'Scheduled'

    class Status(models.TextChoices):
        CREATED = 'created', 'Created'
        IN_PROGRESS = 'in_progress', 'In progress'
        FAILED = 'failed', 'Failed'
        COMPLETED = 'completed', 'Completed'

    scope = models.CharField(max_length=32, choices=Scope.choices, default=Scope.PROJECT, db_index=True)
    project = models.ForeignKey(
        LayoutProject,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='snapshots',
        help_text='Project scope for manual exports; blank for all-task scheduled snapshots.',
    )
    trigger_type = models.CharField(
        max_length=32,
        choices=TriggerType.choices,
        default=TriggerType.MANUAL,
        db_index=True,
    )
    status = models.CharField(max_length=32, choices=Status.choices, default=Status.CREATED, db_index=True)
    file = models.FileField(upload_to=layout_snapshot_upload_to, null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='layout_snapshots_created',
    )
    cutoff_at = models.DateTimeField(db_index=True, help_text='Point-in-time represented by this snapshot.')
    filters = models.JSONField(default=dict, blank=True)
    counters = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        app_label = 'store_layout'
        ordering = ['-cutoff_at', '-created_at']
        verbose_name = 'Layout Task Snapshot'
        verbose_name_plural = 'Task Snapshots'

    def __str__(self):
        target = self.project.name if self.scope == self.Scope.PROJECT and self.project_id else 'All tasks'
        cutoff_text = timezone.localtime(self.cutoff_at).strftime('%Y-%m-%d %H:%M:%S') if self.cutoff_at else 'n/a'
        return f'{target} snapshot @ {cutoff_text} [{self.status}]'

    def save(self, *args, **kwargs):
        if self.scope != self.Scope.PROJECT:
            self.project = None
        if self.cutoff_at is None:
            self.cutoff_at = timezone.now()
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        stored_file = self.file
        super().delete(*args, **kwargs)
        if stored_file:
            stored_file.delete(save=False)
