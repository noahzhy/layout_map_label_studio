from django.urls import path

from . import views

app_name = 'layout_viewer'

urlpatterns = [
    path('layout-viewer/', views.index, name='index'),
    path('layout-viewer/<str:store_id>/', views.viewer_page, name='viewer'),
    path('layout-viewer/<str:store_id>/save-data', views.save_data, name='save-data'),
    path('layout-viewer/<str:store_id>/mark-done', views.mark_done, name='mark-done'),
]
