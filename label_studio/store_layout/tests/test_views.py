from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from organizations.models import Organization
from tests.utils import signin

from store_layout.models import LayoutProject


pytestmark = pytest.mark.django_db


def _prepare_logged_in_user(client, user, password='secret'):
    organization = Organization.create_organization(created_by=user, title=user.email)
    user.active_organization = organization
    user.save(update_fields=['active_organization'])
    response = signin(client, user.email, password)
    assert response.status_code == 302
    return organization


@pytest.fixture
def admin_user():
    user_model = get_user_model()
    return user_model.objects.create_user(
        username='admin',
        email='admin@example.com',
        password='secret',
        is_staff=True,
    )


@pytest.fixture
def normal_user():
    user_model = get_user_model()
    return user_model.objects.create_user(
        username='annotator',
        email='annotator@example.com',
        password='secret',
    )


@pytest.fixture
def layout_project(admin_user):
    return LayoutProject.objects.create(name='Project Export', created_by=admin_user)


def test_create_project_snapshot_requires_admin(client, normal_user, layout_project):
    _prepare_logged_in_user(client, normal_user)
    response = client.post(reverse('store_layout:project-snapshot-create', kwargs={'pk': layout_project.pk}))
    assert response.status_code == 403


def test_create_project_snapshot_redirects_for_admin(client, admin_user, layout_project):
    _prepare_logged_in_user(client, admin_user)
    with patch('store_layout.views.schedule_layout_task_snapshot') as mocked_schedule:
        response = client.post(reverse('store_layout:project-snapshot-create', kwargs={'pk': layout_project.pk}))

    assert response.status_code == 302
    mocked_schedule.assert_called_once()
