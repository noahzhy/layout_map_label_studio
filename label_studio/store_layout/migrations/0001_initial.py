import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutTask',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('store_id', models.CharField(db_index=True, help_text='Directory name under mydata/layout/', max_length=256)),
                ('status', models.CharField(
                    choices=[
                        ('pending', '待标注'),
                        ('in_progress', '标注中'),
                        ('done', '已完成'),
                        ('reviewed', '已审核'),
                    ],
                    db_index=True,
                    default='pending',
                    max_length=32,
                )),
                ('notes', models.TextField(blank=True, help_text='Admin notes about this task')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('last_saved_at', models.DateTimeField(blank=True, help_text='Last time the annotator saved annotation data', null=True)),
                ('assigned_to', models.ForeignKey(
                    blank=True,
                    help_text='Annotator assigned to label this store',
                    null=True,
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='layout_tasks',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('assigned_by', models.ForeignKey(
                    blank=True,
                    help_text='Admin who created this assignment',
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='layout_tasks_assigned_by',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'verbose_name': 'Layout Task',
                'verbose_name_plural': 'Tasks',
                'ordering': ['-created_at'],
            },
        ),
        migrations.AlterUniqueTogether(
            name='layouttask',
            unique_together={('store_id', 'assigned_to')},
        ),
    ]
