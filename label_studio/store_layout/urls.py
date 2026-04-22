from django.urls import path

from . import views

app_name = 'store_layout'

urlpatterns = [
    # Project list (root)
    path('store_layout/', views.index, name='index'),
    # Project detail: stores within a project  (must be before <str:store_id>/)
    path('store_layout/projects/<int:pk>/', views.project_detail, name='project-detail'),
    # Task assignment management (admin only)
    path('store_layout/projects/<int:pk>/assign/', views.assign_tasks, name='assign-tasks'),
    # Viewer
    path('store_layout/<str:store_id>/', views.viewer_page, name='viewer'),
    path('store_layout/<str:store_id>/save-data', views.save_data, name='save-data'),
    path('store_layout/<str:store_id>/mark-done', views.mark_done, name='mark-done'),
]
