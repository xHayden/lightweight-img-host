#!/usr/bin/env python3
"""
Screenshot Sync Service for macOS
---------------------------------
Monitors a directory for new screenshots and uploads them to
the image host.  When the upload succeeds the resulting
public URL is copied to the clipboard.  Designed to run as a LaunchAgent
so it automatically restarts at login and after crashes.

• Uses FSEventsObserver – the native macOS file‑watcher backend – for
  greater reliability.
• Debounces duplicate create/modify events so every screenshot is
  uploaded exactly once.
• Waits until the file size is stable before opening it, avoiding
  partially‑written uploads.
• One persistent requests.Session with retry/back‑off logic handles
  flaky networks cleanly.
• No thread‑spawning restarts; the observer lives for the process
  lifetime and shuts down gracefully on SIGINT.
• Pathlib, typing, detailed structured logging.
• Sends x-api-key header for authenticated uploads to B2-backed host.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from threading import Event
from typing import Dict, Set
from urllib.parse import urljoin

import pyperclip
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from watchdog.events import FileCreatedEvent, FileModifiedEvent, FileSystemEventHandler
from watchdog.observers.fsevents import FSEventsObserver

# --------------------------- Configuration --------------------------- #

SCREENSHOT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "~/Documents/Screenshots")).expanduser()
UPLOAD_URL = os.environ.get("UPLOAD_URL", "https://img.hayden.gg/")
UPLOAD_ENDPOINT = UPLOAD_URL.rstrip("/") + "/upload"
API_KEY = os.environ.get("UPLOAD_API_KEY", "")
ALLOWED_EXTENSIONS: Set[str] = {".gif", ".png", ".jpg", ".jpeg", ".pdf", ".webp"}

DEBOUNCE_SECONDS = 0.3          # merge events arriving within this window
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
    """Upload files with automatic retry/back‑off."""

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
            # Rewrite CDN URL to the main host URL for sharing
            cdn_url = os.environ.get("B2_CDN_URL", "https://files.hayden.gg")
            if link.startswith(cdn_url):
                filename = link[len(cdn_url):]
                link = UPLOAD_URL.rstrip("/") + filename
            elif not link.startswith("http"):
                link = urljoin(UPLOAD_URL, link)
        else:
            logging.error("Upload failed for %s (status %d)", file_path, resp.status_code)
            link = self._extract_link_fallback(resp.text)

        logging.info("Uploaded %s → %s", file_path, link)
        pyperclip.copy(link)
        return link

    @staticmethod
    def _extract_link_fallback(html: str) -> str:
        import re

        match = re.search(r"https?://\S+", html)
        return match.group(0) if match else "ERROR_NO_LINK_FOUND"

# ----------------------------- Watcher ------------------------------- #

class ScreenshotHandler(FileSystemEventHandler):
    """Handle new and modified files in *SCREENSHOT_DIR*."""

    def __init__(self, uploader: ReliableUploader) -> None:
        self.uploader = uploader
        self._recent: Dict[Path, float] = {}
        self._stop_event = Event()

    def stop(self) -> None:
        self._stop_event.set()

    def _should_handle(self, path: Path) -> bool:
        return (
            path.suffix.lower() in ALLOWED_EXTENSIONS
            and not path.name.startswith(".")
        )

    def _debounced(self, path: Path) -> bool:
        """Return True if *path* has been seen very recently."""
        now = time.time()
        last = self._recent.get(path, 0)
        if (now - last) < DEBOUNCE_SECONDS:
            return True
        self._recent[path] = now
        return False

    def _wait_until_stable(self, path: Path) -> None:
        size1 = path.stat().st_size
        time.sleep(FILE_STABLE_WAIT)
        while True:
            size2 = path.stat().st_size
            if size2 == size1:
                return
            size1 = size2
            time.sleep(FILE_STABLE_WAIT)

    def on_created(self, event):
        if isinstance(event, (FileCreatedEvent, FileModifiedEvent)):
            self._handle(event.src_path)

    on_modified = on_created

    def _handle(self, raw_path: str):
        path = Path(raw_path)
        if not self._should_handle(path):
            return
        if self._debounced(path):
            return

        try:
            self._wait_until_stable(path)
            self.uploader.upload(path)
        except Exception as exc:  # noqa: BLE001
            logging.exception("Error processing %s: %s", path, exc)

# ------------------------------ main -------------------------------- #


def main() -> None:  # pragma: no cover
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    if not API_KEY:
        logging.warning("No UPLOAD_API_KEY set. Uploads will fail if server requires auth.")

    uploader = ReliableUploader(UPLOAD_ENDPOINT)
    handler = ScreenshotHandler(uploader)
    observer = FSEventsObserver()
    observer.schedule(handler, str(SCREENSHOT_DIR), recursive=False)

    observer.start()
    logging.info("Screenshot sync started for %s", SCREENSHOT_DIR)

    try:
        while not handler._stop_event.is_set():
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join()
        logging.info("Screenshot sync stopped.")


if __name__ == "__main__":
    main()
