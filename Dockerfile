# Ledger live: the record kept in one Relate store, as a Linux container (ledger/live.py, `ledger serve`).
#   docker build -t ledger-live .
#   docker run --rm -p 8790:8790 -v ledger_state:/data ledger-live \
#       serve --host 0.0.0.0 --port 8790 --state /data --runner https://race.gladiatorbench.com \
#       --origin https://ledger.gladiatorbench.com
#
# The image carries the code and the sealed records it was built with (data/records, data/validations,
# data/epoch): the baseline the service starts from. What it takes in from the runner afterwards, and the store
# itself, live in the state folder (a volume at /data). It holds no key and needs none.
ARG BASE=python:3.12-slim
FROM ${BASE}

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1

WORKDIR /app
# Dependencies first (cached layer), exactly as pinned in uv.lock.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY ledger ledger
COPY data/records data/records
COPY data/validations data/validations
COPY data/epoch data/epoch
COPY docker-entrypoint.sh ./
RUN uv sync --frozen --no-dev \
    && chmod -R a+rX /app && chmod a+x /app/docker-entrypoint.sh \
    && useradd --create-home ledger && mkdir -p /data && chown ledger /data

ENV PATH="/app/.venv/bin:$PATH"
# Never runs the service as root: the entrypoint only makes a mounted folder writable, then drops to `ledger`.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["--help"]
