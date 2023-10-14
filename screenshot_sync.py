import os
import time
import requests
import pyperclip
from threading import Thread
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import logging
from dotenv import load_dotenv

load_dotenv()
SCREENSHOT_DIR = os.environ.SCREENSHOT_DIR
BASE_URL = os.environ.SCREENSHOT_BASE_URL

log_file = os.path.join(SCREENSHOT_DIR, 'screenshot_sync_log.txt')
logging.basicConfig(filename=log_file, level=logging.INFO, format='%(asctime)s - %(message)s')

class ScreenshotHandler(FileSystemEventHandler):
    def __init__(self, observer):
        self.observer = observer

    def on_modified(self, event):
        self.process_event(event)

    def on_created(self, event):
        self.process_event(event)

    def process_event(self, event):
        logging.info(f"Detected event for file: {event.src_path}")  # Logging
        allowed_extensions = ['.gif', '.png', '.jpg', '.jpeg']
        if not event.is_directory and not os.path.basename(event.src_path).startswith('.'):
            file_extension = os.path.splitext(event.src_path)[1].lower()
            if file_extension in allowed_extensions:
                self.upload_screenshot(event.src_path)

    def upload_screenshot(self, filepath):
        logging.info(f"Uploading: {filepath}") 
        with open(filepath, 'rb') as f:
            files = {'file-uploaded': f}
            response = requests.post(BASE_URL + "upload", files=files, allow_redirects=False)
            
            if 300 <= response.status_code < 400:
                link = BASE_URL + response.headers.get('Location', None)
            else:
                logging.error("Failed to upload correct file with filepath {filepath}")
                link = self.extract_link(response.text)
            
            logging.info(f"Uploaded {filepath}. Link: {link}")
            pyperclip.copy(link)
            self.reset_observer()

    def reset_observer(self):
        self.observer.stop()
        restart_thread = Thread(target=start_observer)
        restart_thread.start()

def start_observer():
    observer = Observer()
    event_handler = ScreenshotHandler(observer)
    observer.schedule(event_handler, SCREENSHOT_DIR, recursive=False)
    observer.start()
    return observer

if __name__ == "__main__":
    observer = start_observer()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
