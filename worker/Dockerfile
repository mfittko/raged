FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for spaCy
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with explicit UID/GID 1000 to match Helm chart
RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --create-home app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download spaCy English model
RUN python -m spacy download en_core_web_sm

COPY --chown=app:app src/ src/

# Switch to non-root user
USER app

CMD ["python", "-m", "src.main"]
