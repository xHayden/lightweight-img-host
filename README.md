# lightweight-img-host
 Kinda terrible, but usable lightweight image hosting service that keeps everything local. I wrote this code years ago and it isn't great (mainly because it's using Pug around Express and not a real framework). Still works and does everything I need it to do!

 Includes an admin panel for removing sensitive images secured by Auth0.
 Images are stored in `uploads/`.

`screenshot_sync.py` is a quick python script ChatGPT wrote to take my MacOS screenshots folder and upload it to this server.

To use with https, create a folder called `cert/` and add a `server.crt` and `server.key` file.

Required `.env` variables:
```
SECRET=AUTH0_SECRET
BASE_URL=URL_OF_WEB_SERVER
CLIENT_ID=AUTH0_CLIENT
ISSUER_BASE_URL=AUTH0_URL
ALLOWED_USERS=[email1, email2, ...]
```