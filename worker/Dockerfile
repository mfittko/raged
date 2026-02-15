FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for spaCy
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system app && useradd --system --gid app app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download spaCy English model
RUN python -m spacy download en_core_web_sm

COPY src/ src/

# Set ownership and switch to non-root user
RUN chown -R app:app /app
USER app

CMD ["python", "-m", "src.main"]
