import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('layout_viewer', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='LayoutProject',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(help_text='Project name', max_length=256)),
                ('description', models.TextField(blank=True, help_text='Project description / notes for annotators')),
                ('is_archived', models.BooleanField(db_index=True, default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='created_layout_projects',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'verbose_name': 'Layout Project',
                'verbose_name_plural': 'Layout Projects',
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddField(
            model_name='layouttask',
            name='project',
            field=models.ForeignKey(
                blank=True,
                help_text='Parent project (optional)',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='tasks',
                to='layout_viewer.layoutproject',
            ),
        ),
    ]
