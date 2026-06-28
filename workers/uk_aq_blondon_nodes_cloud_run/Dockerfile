FROM python:3.12-slim
WORKDIR /app
COPY workers/uk_aq_blondon_nodes_cloud_run/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY scripts /app/scripts
COPY workers/uk_aq_blondon_nodes_cloud_run/run_service.py /app/workers/uk_aq_blondon_nodes_cloud_run/run_service.py
ENV PORT=8000
CMD ["python3", "/app/workers/uk_aq_blondon_nodes_cloud_run/run_service.py"]
