import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** PyPI package recognition (pip / poetry / pipenv). Plugin-owned. */
export const pypiPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["django"], category: "framework", framework: { id: "django", name: "Django" } },
  { names: ["flask"], category: "framework", framework: { id: "flask", name: "Flask" } },
  { names: ["fastapi"], category: "framework", framework: { id: "fastapi", name: "FastAPI" } },
  { names: ["starlette"], category: "framework", framework: { id: "starlette", name: "Starlette" } },
  { names: ["sanic"], category: "framework", framework: { id: "sanic", name: "Sanic" } },
  { names: ["tornado"], category: "framework", framework: { id: "tornado", name: "Tornado" } },
  { names: ["aiohttp"], category: "framework", framework: { id: "aiohttp", name: "aiohttp" } },
  { names: ["bottle"], category: "framework", framework: { id: "bottle", name: "Bottle" } },
  { names: ["falcon"], category: "framework", framework: { id: "falcon", name: "Falcon" } },
  { names: ["pyramid"], category: "framework", framework: { id: "pyramid", name: "Pyramid" } },
  { names: ["celery"], category: "messaging", framework: { id: "celery", name: "Celery" } },
  { names: ["pika", "aio-pika"], category: "messaging", framework: { id: "rabbitmq", name: "RabbitMQ" } },
  { names: ["kafka-python", "confluent-kafka", "aiokafka"], category: "messaging", framework: { id: "kafka", name: "Kafka" } },
  { names: ["scrapy"], category: "framework", framework: { id: "scrapy", name: "Scrapy" } },
  // ── ORM ──
  { names: ["sqlalchemy", "tortoise-orm", "peewee", "pony"], category: "orm" },
  // ── Database drivers ──
  { names: ["psycopg2", "psycopg2-binary", "pymysql", "pymongo", "redis-py"], category: "database" },
  // ── HTTP ──
  { names: ["requests", "httpx", "urllib3", "aiohttp-client"], category: "http" },
  // ── Auth ──
  { names: ["pyjwt", "passlib", "authlib", "python-jose"], category: "auth" },
  // ── Validation ──
  { names: ["pydantic", "marshmallow", "cerberus"], category: "validation" },
  // ── Logging ──
  { names: ["loguru", "structlog"], category: "logging" },
  // ── Cloud ──
  { names: ["boto3", "google-cloud-storage", "azure-storage-blob"], category: "cloud" },
  // ── Testing ──
  { names: ["pytest", "nose", "tox", "hypothesis"], category: "testing" },
  // ── Build ──
  { names: ["setuptools", "poetry", "wheel", "build", "hatchling"], category: "build" },
  // ── Lint ──
  { names: ["black", "flake8", "ruff", "mypy", "pylint", "isort"], category: "lint" },
  // ── Data / scientific (utility) ──
  { names: ["numpy", "pandas", "scipy", "matplotlib"], category: "util" },
  // ── Family patterns ──
  { match: /^pytest-/, category: "testing" },
  // ── Cache / mail ──
  { names: ["cachetools", "aiocache", "django-redis", "dogpile.cache"], category: "cache" },
  { names: ["flask-mail", "django-anymail", "sendgrid", "yagmail", "emails"], category: "email" },

];
