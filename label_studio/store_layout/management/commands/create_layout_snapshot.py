import logging

from django.core.management.base import BaseCommand, CommandError

from store_layout.models import LayoutProject, LayoutTaskSnapshot
from store_layout.snapshot_service import schedule_layout_task_snapshot

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Create a Store Layout task snapshot for one project or for all tasks.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--scope',
            choices=['all', 'project'],
            default='all',
            help='Snapshot either all layout tasks or only one project.',
        )
        parser.add_argument('--project-id', type=int, help='Required when --scope=project.')
        parser.add_argument(
            '--trigger',
            choices=[LayoutTaskSnapshot.TriggerType.MANUAL, LayoutTaskSnapshot.TriggerType.SCHEDULED],
            default=LayoutTaskSnapshot.TriggerType.SCHEDULED,
            help='Describe why this snapshot is created.',
        )
        parser.add_argument(
            '--sync',
            action='store_true',
            help='Run synchronously instead of enqueueing on the RQ worker queue.',
        )

    def handle(self, *args, **options):
        scope_option = options['scope']
        project_id = options.get('project_id')

        if scope_option == 'project' and not project_id:
            raise CommandError('--project-id is required when --scope=project')
        if scope_option == 'all' and project_id:
            raise CommandError('--project-id can only be used when --scope=project')

        project = None
        snapshot_scope = LayoutTaskSnapshot.Scope.ALL_TASKS
        if scope_option == 'project':
            snapshot_scope = LayoutTaskSnapshot.Scope.PROJECT
            try:
                project = LayoutProject.objects.get(pk=project_id)
            except LayoutProject.DoesNotExist as exc:
                raise CommandError(f'LayoutProject {project_id} does not exist') from exc

        snapshot = schedule_layout_task_snapshot(
            snapshot_scope,
            project=project,
            trigger_type=options['trigger'],
            created_by=None,
            filters={'requested_from': 'management_command'},
            use_async=not options['sync'],
        )
        snapshot.refresh_from_db()

        target = project.name if project else 'all tasks'
        logger.info('Created Store Layout snapshot %s for %s with status %s', snapshot.pk, target, snapshot.status)
        self.stdout.write(
            self.style.SUCCESS(
                f'Created snapshot {snapshot.pk} for {target} with status {snapshot.status} at {snapshot.cutoff_at.isoformat()}'
            )
        )
