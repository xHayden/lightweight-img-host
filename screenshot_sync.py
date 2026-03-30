#!/usr/bin/env python3
"""
Screenshot Sync Service for macOS
---------------------------------
Monitors a directory for new screenshots and uploads them to
the image host.  When the upload succeeds the resulting
public URL is copied to the clipboard.  Designed to run as a LaunchAgent
so it automatically restarts at login and after crashes.

* Polls the screenshot directory every 0.5 s — no FSEvents dependency,
  no macOS throttling delays.
* Deduplicates by tracking (path, mtime) of uploaded files.
* Waits until the file size is stable before opening it, avoiding
  partially-written uploads.
* One persistent requests.Session with retry/back-off logic handles
  flaky networks cleanly.
* Sends x-api-key header for authenticated uploads to B2-backed host.
"""

from __future__ import annotations

import logging
import os
import signal
import time
from pathlib import Path
from typing import Dict, Set
from urllib.parse import urljoin

import pyperclip
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --------------------------- Configuration --------------------------- #

SCREENSHOT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "~/Documents/Screenshots")).expanduser()
UPLOAD_URL = os.environ.get("UPLOAD_URL", "https://img.hayden.gg/")
UPLOAD_ENDPOINT = UPLOAD_URL.rstrip("/") + "/upload"
API_KEY = os.environ.get("UPLOAD_API_KEY", "")
ALLOWED_EXTENSIONS: Set[str] = {".gif", ".png", ".jpg", ".jpeg", ".pdf", ".webp"}

POLL_INTERVAL = 0.5             # seconds between directory scans
MAX_RETRIES = 3                 # network retry attempts
RETRY_BACKOFF = 1               # seconds, exponential factor handled by urllib3
FILE_STABLE_WAIT = 0.2          # time to wait before checking file size again

LOG_FILE = SCREENSHOT_DIR / "screenshot_sync.log"

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ------------------------------ Uploader ----------------------------- #


class ReliableUploader:
    """Upload files with automatic retry/back-off."""

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.session = requests.Session()
        if API_KEY:
            self.session.headers["x-api-key"] = API_KEY
        retry = Retry(
            total=MAX_RETRIES,
            connect=MAX_RETRIES,
            read=MAX_RETRIES,
            backoff_factor=RETRY_BACKOFF,
            status_forcelist=[502, 503, 504],
            allowed_methods=["POST"],
        )
        self.session.mount("https://", HTTPAdapter(max_retries=retry))

    def upload(self, file_path: Path) -> str:
        """Upload *file_path* and return the public URL."""
        logging.info("Uploading %s", file_path)
        with file_path.open("rb") as fh:
            resp = self.session.post(
                self.endpoint,
                files={"file-uploaded": fh},
                allow_redirects=False,
                timeout=30,
            )

        if 300 <= resp.status_code < 400 and "Location" in resp.headers:
            link = resp.headers["Location"]
            cdn_url = os.environ.get("B2_CDN_URL", "https://files.hayden.gg")
            if link.startswith(cdn_url):
                filename = link[len(cdn_url):]
                link = UPLOAD_URL.rstrip("/") + filename
            elif not link.startswith("http"):
                link = urljoin(UPLOAD_URL, link)
        else:
            logging.error("Upload failed for %s (status %d)", file_path, resp.status_code)
            link = self._extract_link_fallback(resp.text)

        logging.info("Uploaded %s -> %s", file_path, link)
        pyperclip.copy(link)
        return link

    @staticmethod
    def _extract_link_fallback(html: str) -> str:
        import re

        match = re.search(r"https?://\S+", html)
        return match.group(0) if match else "ERROR_NO_LINK_FOUND"


# ------------------------------ Helpers ------------------------------ #


def wait_until_stable(path: Path) -> None:
    """Block until *path*'s size stops changing."""
    size = path.stat().st_size
    time.sleep(FILE_STABLE_WAIT)
    while True:
        new_size = path.stat().st_size
        if new_size == size:
            return
        size = new_size
        time.sleep(FILE_STABLE_WAIT)


# ------------------------------ Main --------------------------------- #


running = True


def _shutdown(signum, frame):
    global running
    running = False


def main() -> None:
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    if not API_KEY:
        logging.warning("No UPLOAD_API_KEY set. Uploads will fail if server requires auth.")

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    uploader = ReliableUploader(UPLOAD_ENDPOINT)

    # Seed with existing files so we only upload new ones after startup.
    processed: Dict[Path, float] = {}
    for entry in SCREENSHOT_DIR.iterdir():
        if entry.is_file() and entry.suffix.lower() in ALLOWED_EXTENSIONS:
            processed[entry] = entry.stat().st_mtime

    logging.info("Screenshot sync started for %s (%d existing files)", SCREENSHOT_DIR, len(processed))

    while running:
        for entry in SCREENSHOT_DIR.iterdir():
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            if entry.name.startswith("."):
                continue

            mtime = entry.stat().st_mtime
            if processed.get(entry) == mtime:
                continue

            try:
                wait_until_stable(entry)
                mtime = entry.stat().st_mtime
                if processed.get(entry) == mtime:
                    continue
                uploader.upload(entry)
                processed[entry] = mtime
            except Exception as exc:
                logging.exception("Error processing %s: %s", entry, exc)

        time.sleep(POLL_INTERVAL)

    logging.info("Screenshot sync stopped.")


if __name__ == "__main__":
    main()
