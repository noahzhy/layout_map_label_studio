from django.urls import path

from . import views

app_name = 'store_layout'

urlpatterns = [
    # Project list (root)
    path('store_layout/', views.index, name='index'),
    path('store_layout/help/translation-table/', views.translation_table, name='translation-table'),
    # Project detail: stores within a project  (must be before <str:store_id>/)
    path('store_layout/projects/<int:pk>/', views.project_detail, name='project-detail'),
    # Task assignment management (admin only)
    path('store_layout/projects/<int:pk>/assign/', views.assign_tasks, name='assign-tasks'),
    # Viewer
    path('store_layout/<str:store_id>/', views.viewer_page, name='viewer'),
    path('store_layout/<str:store_id>/assets-metadata', views.store_assets, name='store-assets'),
    path('store_layout/<str:store_id>/save-data', views.save_data, name='save-data'),
    path('store_layout/<str:store_id>/mark-done', views.mark_done, name='mark-done'),
    path('store_layout/<str:store_id>/update-status', views.update_status, name='update-status'),
    # Serve layout files (fallback when nginx is not fronting Django).
    # Must come AFTER the routes above so it doesn't shadow them.
    path('store_layout/<str:store_id>/<path:filename>', views.serve_file, name='serve-file'),
]
