import logging
import os
import sys

import environ
from django.core.management.utils import get_random_secret_key

logger = logging.getLogger(__name__)


def is_collectstatic() -> bool:
    for arg in sys.argv:
        if 'collectstatic' in arg:
            return True

    return False


def generate_secret_key_if_missing(data_dir: str) -> str:
    env_key = 'SECRET_KEY'
    env_filepath = os.path.join(data_dir, '.env')

    # IMPORTANT:
    # This file is stored under the persistent data dir and should be used only
    # for SECRET_KEY persistence. Loading the whole file into process env can
    # accidentally override runtime configuration (e.g. DJANGO_DB=sqlite) in
    # k8s/docker deployments after restarts.
    existing_secret = os.environ.get(env_key, '')
    if not existing_secret and os.path.exists(env_filepath):
        try:
            with open(env_filepath, 'r') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    key, value = line.split('=', 1)
                    if key.strip() == env_key:
                        existing_secret = value.strip().strip('"').strip("'")
                        break
        except Exception as e:
            logger.warning(f'Warning: failed to read {env_key} from .env file: {e}')

    if existing_secret:
        return existing_secret

    logger.warning(f'Warning: {env_key} not found in environment variables. Will generate a random key.')
    new_secret = get_random_secret_key()

    if is_collectstatic():
        logger.info(
            'Random SECRET_KEY was generated, but it is not being persisted because this is a collectstatic run'
        )
        return new_secret

    try:
        with open(env_filepath, 'a') as f:
            f.write(f'\n{env_key}={new_secret}\n')  # nosec
    except Exception as e:
        logger.warning(
            f'Warning: failed to write {env_key} to .env file: {e}, new key will be regenerated on every '
            f'server restart. If this key is used for signing, it will invalidate all existing sessions '
            f'or tokens. Please set {env_key} in your environment variables to avoid this warning.'
        )

    os.environ[env_key] = new_secret
    return new_secret
