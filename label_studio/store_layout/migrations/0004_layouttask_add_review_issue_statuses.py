from django.db import migrations, models


NEW_CHOICES = [
    ('unannotated', '未标注'),
    ('s1_in_progress', 'S1标注中'),
    ('s1_done', 'S1标注完成'),
    ('s2_in_progress', 'S2标注中'),
    ('s2_done', 'S2标注完成'),
    ('reviewed', '已审核'),
    ('map_issue', '地图问题'),
    ('unknown_error', '未知错误'),
    ('review_in_progress', '审核中'),
    ('review_rejected', '审核未通过'),
]


OLD_CHOICES = [
    ('unannotated', '未标注'),
    ('s1_in_progress', 'S1标注中'),
    ('s1_done', 'S1标注完成'),
    ('s2_in_progress', 'S2标注中'),
    ('s2_done', 'S2标注完成'),
    ('reviewed', '已审核'),
]


class Migration(migrations.Migration):

    dependencies = [
        ('store_layout', '0003_layouttask_s1_s2_statuses'),
    ]

    operations = [
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
