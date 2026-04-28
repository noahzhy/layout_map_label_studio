#!/bin/sh
set -e ${DEBUG:+-x}

# In some deployment platforms, LABEL_STUDIO_DJANGO_DB may be injected unexpectedly.
# If Postgres host is configured, default to Postgres unless user explicitly overrides later.
if [ -n "${POSTGRE_HOST:-}" ]; then
  export DJANGO_DB="${DJANGO_DB:-default}"
  export LABEL_STUDIO_DJANGO_DB="${LABEL_STUDIO_DJANGO_DB:-$DJANGO_DB}"

  if [ "${DJANGO_DB}" = "sqlite" ] || [ "${LABEL_STUDIO_DJANGO_DB}" = "sqlite" ]; then
    echo >&3 "=> WARN: POSTGRE_HOST is set but DB engine is sqlite; force switch to PostgreSQL (default)."
    export DJANGO_DB="default"
    export LABEL_STUDIO_DJANGO_DB="default"
  fi
fi

if [ "${SKIP_DB_MIGRATIONS:-}" != "true" ] && { [ -n "${POSTGRE_HOST:-}" ] || [ -n "${MYSQL_HOST:-}" ]; }; then
  echo >&3 "=> Do database migrations..."
  python3 /label-studio/label_studio/manage.py locked_migrate >&3
  echo >&3 "=> Migrations completed."
else
  echo >&3 "=> Skipping run db migrations."
fi

if [ -n "${LABEL_STUDIO_USERNAME:-}" ] && [ -n "${LABEL_STUDIO_PASSWORD:-}" ]; then
  echo >&3 "=> Ensuring default Django admin user exists..."
  python3 /label-studio/label_studio/manage.py shell -c "from core.utils.params import get_env; from organizations.models import Organization; from users.models import User; username=get_env('USERNAME'); password=get_env('PASSWORD'); user=User.objects.filter(email=username).first(); created=False; updated=False; user=user or User.objects.create_user(email=username, password=password); created = user.email == username and user.date_joined is not None and not user.check_password(''); user.username = user.username or username.split('@')[0]; changed_password = bool(password) and not user.check_password(password); changed_staff = not user.is_staff; changed_superuser = not user.is_superuser; user.is_staff = True; user.is_superuser = True; org = Organization.objects.first(); org = org or Organization.create_organization(created_by=user, title='Label Studio'); user.active_organization = user.active_organization or org; org.add_user(user); updated_fields = []; updated_fields.extend(['username'] if user.username == username.split('@')[0] else []); updated_fields.extend(['is_staff'] if changed_staff else []); updated_fields.extend(['is_superuser'] if changed_superuser else []); updated_fields.extend(['active_organization'] if user.active_organization_id == org.id else []); updated_fields.extend(['password'] if changed_password else []); user.set_password(password) if changed_password else None; user.save() if created or changed_password or changed_staff or changed_superuser or user.active_organization_id == org.id else None; print(f'=> Default admin ensured: {username}')" >&3
fi