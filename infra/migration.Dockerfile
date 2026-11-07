FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /etc/ssl/certs/rds-global-bundle.pem \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir 'psycopg[binary]>=3.2,<4' 'boto3>=1.35,<2' \
    && groupadd --gid 10001 auralis && useradd --uid 10001 --gid 10001 --no-create-home auralis
WORKDIR /app
COPY infra/postgres/schema.sql infra/postgres/provision.py infra/tests/rls_probe.py ./
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
CMD ["python", "provision.py"]
