FROM python:3.12-slim
WORKDIR /app
COPY requirements-dev.txt /app/requirements-dev.txt
RUN pip install --no-cache-dir -r /app/requirements-dev.txt
COPY scripts /app/scripts
COPY workers/uk_aq_blondon_nodes_cloud_run/run_service.py /app/workers/uk_aq_blondon_nodes_cloud_run/run_service.py
ENV PORT=8000
CMD ["python3", "/app/workers/uk_aq_blondon_nodes_cloud_run/run_service.py"]
