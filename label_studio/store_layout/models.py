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
