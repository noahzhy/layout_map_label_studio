from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import store_layout.models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('store_layout', '0004_layouttask_add_review_issue_statuses'),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutTaskSnapshot',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                (
                    'scope',
                    models.CharField(
                        choices=[('project', 'Project'), ('all_tasks', 'All tasks')],
                        db_index=True,
                        default='project',
                        max_length=32,
                    ),
                ),
                (
                    'trigger_type',
                    models.CharField(
                        choices=[('manual', 'Manual'), ('scheduled', 'Scheduled')],
                        db_index=True,
                        default='manual',
                        max_length=32,
                    ),
                ),
                (
                    'status',
                    models.CharField(
                        choices=[
                            ('created', 'Created'),
                            ('in_progress', 'In progress'),
                            ('failed', 'Failed'),
                            ('completed', 'Completed'),
                        ],
                        db_index=True,
                        default='created',
                        max_length=32,
                    ),
                ),
                ('file', models.FileField(blank=True, null=True, upload_to=store_layout.models.layout_snapshot_upload_to)),
                (
                    'cutoff_at',
                    models.DateTimeField(db_index=True, help_text='Point-in-time represented by this snapshot.'),
                ),
                ('filters', models.JSONField(blank=True, default=dict)),
                ('counters', models.JSONField(blank=True, default=dict)),
                ('error_message', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                (
                    'created_by',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='layout_snapshots_created',
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    'project',
                    models.ForeignKey(
                        blank=True,
                        help_text='Project scope for manual exports; blank for all-task scheduled snapshots.',
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='snapshots',
                        to='store_layout.layoutproject',
                    ),
                ),
            ],
            options={
                'verbose_name': 'Layout Task Snapshot',
                'verbose_name_plural': 'Task Snapshots',
                'ordering': ['-cutoff_at', '-created_at'],
            },
        ),
    ]
