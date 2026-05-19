# Store Layout Map Kubernetes health checks

This directory contains a minimal Kubernetes example for the image built by `src/build.sh`.

## What the example assumes

`deployment.example.yaml` assumes the image runs with its default Docker command:

- `CMD ["label-studio"]`
- HTTP listens on `8080`
- Kubernetes probes can hit `http://<pod>:8080/health`

This is the simplest and safest way to start on Kubernetes because it matches the image built by `src/Dockerfile`.

## Probe contract

The repository already exposes these endpoints:

- App health: `/health`
- Nginx-only health: `/nginx_health`

Use them like this:

### Default single-container mode

Use the same probe endpoint for all three probe types:

- `startupProbe` -> `/health` on port `8080`
- `readinessProbe` -> `/health` on port `8080`
- `livenessProbe` -> `/health` on port `8080`

Why `startupProbe` matters: container startup waits for the database and may run migrations before the app starts listening. Without `startupProbe`, Kubernetes may restart the pod too early.

### Split nginx + app mode

Only use this if you intentionally mirror `docker-compose.deploy.yml` on Kubernetes.

- app container command: `label-studio-uwsgi`
  - probe `http://127.0.0.1:8000/health`
- nginx container command: `nginx`
  - probe `http://127.0.0.1:8085/nginx_health`

Do not reuse the single-container `8080` probes for this split mode.

## Suggested rollout flow

1. Build and push an immutable image tag.
   - `src/build.sh` already defaults to a timestamp tag, which is ideal for Kubernetes rollouts.
2. Update the Deployment image to the new tag.
3. Wait for rollout completion.
4. If rollout stalls, inspect probe failures before rolling back.

## Required environment variables

The pod should receive the same core settings currently defined in `src/.env.deploy`, especially:

- `POSTGRE_HOST`
- `POSTGRE_PORT`
- `POSTGRE_NAME`
- `POSTGRE_USER`
- `POSTGRE_PASSWORD`
- `LABEL_STUDIO_SECRET_KEY`
- `LABEL_STUDIO_HOST`
- `CSRF_TRUSTED_ORIGINS`
- `LABEL_STUDIO_USERNAME`
- `LABEL_STUDIO_PASSWORD`

At minimum, make sure the mounted `/label-studio/data` volume is writable by UID `1001`.

## Docker image health check

`src/Dockerfile` now includes a Docker `HEALTHCHECK` that supports all startup modes used in this repository:

- `127.0.0.1:8080/health` for default single-container mode
- `127.0.0.1:8000/health` for `label-studio-uwsgi`
- `127.0.0.1:8085/nginx_health` for `nginx`

That container-level check is useful for local Docker and some runtimes, but Kubernetes should still rely on explicit probes in the Deployment.
