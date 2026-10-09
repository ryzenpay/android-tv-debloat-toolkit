# Android TV Toolkit — web UI + a real ADB client.
#
# ADB has to come from inside the image: the repo ships a 2-byte adb/adb.exe stub and Debian's
# adb is platform-tools 28.0.2, which has no 'adb pair' and so cannot do the Wireless Debugging
# flow. setup.py fetches Google's official build into ./adb, which the toolkit prefers over PATH.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TOOLKIT_HOST=0.0.0.0 \
    TOOLKIT_PORT=8000 \
    TOOLKIT_NO_BROWSER=1

WORKDIR /app

# Requirements first: this layer is reused on every code-only rebuild.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

RUN python setup.py \
 && useradd --create-home --uid 1000 toolkit \
 && mkdir -p /home/toolkit/.android \
 && chown -R toolkit:toolkit /app /home/toolkit/.android

# The only state here is the adb keypair that 'adb pair' writes to $HOME/.android; it goes on a
# volume (see docker-compose.yml) so a rebuild does not un-pair your TV. Which TV to talk to is
# remembered in the browser, not in the container.
# PATH gets ./adb so 'docker compose exec toolkit adb …' works for debugging.
ENV HOME=/home/toolkit \
    PATH=/app/adb:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
VOLUME ["/home/toolkit/.android"]

USER toolkit
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('TOOLKIT_PORT','8000')+'/api/state',timeout=4)"

CMD ["python", "app.py"]
