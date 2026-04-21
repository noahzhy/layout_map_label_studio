from django.urls import path

from . import views

app_name = 'layout_viewer'

urlpatterns = [
    # Project list (root)
    path('layout-viewer/', views.index, name='index'),
    # Project detail: stores within a project  (must be before <str:store_id>/)
    path('layout-viewer/projects/<int:pk>/', views.project_detail, name='project-detail'),
    # Task assignment management (admin only)
    path('layout-viewer/projects/<int:pk>/assign/', views.assign_tasks, name='assign-tasks'),
    # Viewer
    path('layout-viewer/<str:store_id>/', views.viewer_page, name='viewer'),
    path('layout-viewer/<str:store_id>/save-data', views.save_data, name='save-data'),
    path('layout-viewer/<str:store_id>/mark-done', views.mark_done, name='mark-done'),
]
