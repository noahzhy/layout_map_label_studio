from django.db import migrations, models


OLD_TO_NEW_STATUS = {
    'pending': 'unannotated',
    'in_progress': 's1_in_progress',
    'done': 's1_done',
    'reviewed': 'reviewed',
}

NEW_TO_OLD_STATUS = {
    'unannotated': 'pending',
    's1_in_progress': 'in_progress',
    's1_done': 'done',
    's2_in_progress': 'in_progress',
    's2_done': 'done',
    'reviewed': 'reviewed',
}


NEW_CHOICES = [
    ('unannotated', '未标注'),
    ('s1_in_progress', 'S1标注中'),
    ('s1_done', 'S1标注完成'),
    ('s2_in_progress', 'S2标注中'),
    ('s2_done', 'S2标注完成'),
    ('reviewed', '已审核'),
]


OLD_CHOICES = [
    ('pending', '待标注'),
    ('in_progress', '标注中'),
    ('done', '已完成'),
    ('reviewed', '已审核'),
]


def forwards(apps, schema_editor):
    LayoutTask = apps.get_model('store_layout', 'LayoutTask')
    for old, new in OLD_TO_NEW_STATUS.items():
        LayoutTask.objects.filter(status=old).update(status=new)


def backwards(apps, schema_editor):
    LayoutTask = apps.get_model('store_layout', 'LayoutTask')
    for new, old in NEW_TO_OLD_STATUS.items():
        LayoutTask.objects.filter(status=new).update(status=old)


class Migration(migrations.Migration):

    dependencies = [
        ('store_layout', '0002_layoutproject'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
        migrations.AlterField(
            model_name='layouttask',
            name='status',
            field=models.CharField(
                choices=NEW_CHOICES,
                db_index=True,
                default='unannotated',
                max_length=32,
            ),
        ),
    ]
